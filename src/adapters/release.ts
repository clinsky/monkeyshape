/**
 * Packing monkeyshape, for a release and for everything else. A release packs the commit its
 * tag names, in a worktree of its own, so the working tree can't leak in; any other pack is of
 * the working tree as it stands, with the development version `packVersion` gives it.
 */
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { type PackSource, packVersion, releaseTag, type Tarball } from "../core/release.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { run } from "./process.ts";

const fail = (operation: string, path: string, reason: string) =>
  new WorkspaceError({ operation, path, reason });

/** `command` in `cwd`, its stdout trimmed; a nonzero exit fails with its output. */
const must = (cwd: string, command: ReadonlyArray<string>) =>
  run(cwd, command).pipe(
    Effect.flatMap((ran) =>
      ran.code === 0
        ? Effect.succeed(ran.stdout.trim())
        : Effect.fail(fail(command.join(" "), cwd, `${ran.stdout}${ran.stderr}`.trim())),
    ),
  );

const scratch = (prefix: string) =>
  Effect.promise(() => mkdtemp(join(tmpdir(), `mshape-${prefix}-`)));

const remove = (path: string) => Effect.promise(() => rm(path, { recursive: true, force: true }));

interface PackageJson {
  readonly name: string;
  readonly version: string;
  readonly files?: ReadonlyArray<string>;
}

const readPackage = (dir: string) =>
  Effect.tryPromise({
    try: async () => (await Bun.file(join(dir, "package.json")).json()) as PackageJson,
    catch: (cause) => fail("read", join(dir, "package.json"), String(cause)),
  });

/** `bun pm pack` in `dir`; the tarball's path. */
const bunPack = (dir: string, destination: string) =>
  must(dir, [process.execPath, "pm", "pack", "--destination", destination, "--quiet"]).pipe(
    Effect.map((out) => join(destination, out.split("\n").at(-1)?.split("/").at(-1) ?? "")),
  );

/** What decides the version of a pack of `repo`'s working tree. */
export const packSource = (repo: string) =>
  Effect.gen(function* () {
    const { version } = yield* readPackage(repo);
    const tag = releaseTag(version);
    const tagged =
      (yield* run(repo, ["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}`])).code ===
      0;
    const head = yield* must(repo, ["git", "rev-parse", "HEAD"]);
    const tagCommit = tagged ? yield* must(repo, ["git", "rev-parse", `${tag}^{commit}`]) : "";
    const status = yield* must(repo, ["git", "status", "--porcelain", "--untracked-files=no"]);
    return {
      version,
      tagged,
      atTag: tagged && tagCommit === head,
      commit: head.slice(0, 7),
      dirty: status !== "",
    } satisfies PackSource;
  });

/**
 * Packs `repo`'s working tree into `destination` with the version `packVersion` gives it: a
 * copy of what the package ships, so the repo's own package.json is never rewritten.
 */
export const packWorkingTree = (repo: string, destination: string) =>
  Effect.gen(function* () {
    const version = packVersion(yield* packSource(repo));
    const pkg = yield* readPackage(repo);
    if (version === pkg.version) return yield* bunPack(repo, destination);
    const copy = yield* scratch("pack");
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: async () => {
          for (const entry of pkg.files ?? []) {
            if (entry.startsWith("!")) continue;
            const from = join(repo, entry);
            // An entry naming nothing ships nothing, as with `bun pm pack` itself.
            if (
              await stat(from).then(
                () => true,
                () => false,
              )
            )
              await cp(from, join(copy, entry), { recursive: true });
          }
          await Bun.write(
            join(copy, "package.json"),
            `${JSON.stringify({ ...pkg, version }, null, 2)}\n`,
          );
        },
        catch: (cause) => fail("copy for pack", repo, String(cause)),
      });
      yield* Effect.promise(() => mkdir(destination, { recursive: true }));
      return yield* bunPack(copy, destination);
    }).pipe(Effect.ensuring(remove(copy)));
  });

/** Packs `commit` of `repo` as it was committed, in a worktree of its own. */
export const packCommit = (repo: string, commit: string, destination: string) =>
  Effect.gen(function* () {
    const dir = yield* scratch("release");
    const tree = join(dir, "tree");
    yield* must(repo, ["git", "worktree", "add", "--detach", "--quiet", tree, commit]);
    return yield* bunPack(tree, destination).pipe(
      Effect.ensuring(
        run(repo, ["git", "worktree", "remove", "--force", tree]).pipe(
          Effect.ignore,
          Effect.andThen(remove(dir)),
        ),
      ),
    );
  });

const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** The sha256 of a file. */
export const fileDigest = (path: string) =>
  Effect.tryPromise({
    try: async () => sha256(await Bun.file(path).bytes()),
    catch: (cause) => fail("read", path, String(cause)),
  });

const walk = async (dir: string, prefix = ""): Promise<Array<string>> => {
  const out: Array<string> = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(dir, path)));
    else out.push(path);
  }
  return out;
};

/** A tarball's version and each file's content digest, read by unpacking it. */
export const readTarball = (path: string) =>
  Effect.gen(function* () {
    const dir = yield* scratch("tarball");
    return yield* Effect.gen(function* () {
      yield* must(dir, ["tar", "xzf", path, "-C", dir]);
      return yield* Effect.tryPromise({
        try: async (): Promise<Tarball> => {
          const files = new Map<string, string>();
          for (const file of await walk(dir))
            files.set(file, sha256(await Bun.file(join(dir, file)).bytes()));
          const pkg = (await Bun.file(join(dir, "package", "package.json")).json()) as PackageJson;
          return { version: pkg.version, files };
        },
        catch: (cause) => fail("read tarball", path, String(cause)),
      });
    }).pipe(Effect.ensuring(remove(dir)));
  });

/**
 * Downloads `name@version`'s published tarball from the npm registry into `destination`;
 * undefined when that version was never published.
 */
export const fetchPublished = (name: string, version: string, destination: string) =>
  Effect.tryPromise({
    try: async () => {
      const url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
      const response = await fetch(url);
      if (response.status === 404) return undefined;
      if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
      const path = join(destination, `published-${name}-${version}.tgz`);
      await mkdir(destination, { recursive: true });
      await Bun.write(path, await response.arrayBuffer());
      return path;
    },
    catch: (cause) => fail("fetch", `${name}@${version}`, String(cause)),
  });
