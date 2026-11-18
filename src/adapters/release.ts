/**
 * Packing monkeyshape, for a release and for everything else. A release packs the commit its
 * tag names, in a worktree of its own, so the working tree can't leak in; any other pack is of
 * the working tree as it stands, with the development version `packVersion` gives it.
 */
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import {
  BINARY_TARGETS,
  type BinaryTarget,
  binaryAsset,
  binaryEntry,
  type EmbeddedFile,
  lockedPackage,
  OXC_LOADER,
  oxcForBinary,
  type PackSource,
  packVersion,
  RELEASE_DIR,
  releaseTag,
  SUMS_FILE,
  sha256Sums,
  type Tarball,
} from "../core/release.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { bunPath, run } from "./process.ts";

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

/** The Bun running the release (`bunPath`): `bun run release` always runs under one. */
const bun = () => bunPath() ?? "bun";

/** `bun pm pack` in `dir`; the tarball's path. */
const bunPack = (dir: string, destination: string) =>
  must(dir, [bun(), "pm", "pack", "--destination", destination, "--quiet"]).pipe(
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
    // Untracked files count where the package ships them: `bun pm pack` would include them.
    const shipped = (yield* readPackage(repo)).files?.filter((entry) => !entry.startsWith("!"));
    const status = yield* must(repo, [
      "git",
      "status",
      "--porcelain",
      "--untracked-files=all",
      "--",
      "package.json",
      ...(shipped ?? ["."]),
    ]);
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

/** `use` run on `commit` of `repo` as it was committed, checked out in a worktree of its own. */
const inCommitTree = <A>(
  repo: string,
  commit: string,
  use: (tree: string) => Effect.Effect<A, WorkspaceError>,
) =>
  Effect.gen(function* () {
    const dir = yield* scratch("release");
    const tree = join(dir, "tree");
    yield* must(repo, ["git", "worktree", "add", "--detach", "--quiet", tree, commit]);
    return yield* use(tree).pipe(
      Effect.ensuring(
        run(repo, ["git", "worktree", "remove", "--force", tree]).pipe(
          Effect.ignore,
          Effect.andThen(remove(dir)),
        ),
      ),
    );
  });

/** Packs `commit` of `repo` as it was committed, in a worktree of its own. */
export const packCommit = (repo: string, commit: string, destination: string) =>
  inCommitTree(repo, commit, (tree) => bunPack(tree, destination));

/**
 * Packs `commit` and compiles its binaries as `version`, from one worktree with the
 * dependencies its `bun.lock` pins: the tarball's path, then the binaries', `SHA256SUMS` last.
 */
export const releaseCommit = (repo: string, commit: string, version: string, destination: string) =>
  inCommitTree(repo, commit, (tree) =>
    Effect.gen(function* () {
      const tarball = yield* bunPack(tree, destination);
      yield* must(tree, [bun(), "install", "--frozen-lockfile", "--silent"]);
      return [tarball, ...(yield* compileBinaries(tree, destination, version))];
    }),
  );

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

/** What the package ships besides `src/`, which the binary bundles: every file, sorted. */
const shippedFiles = async (repo: string, pkg: PackageJson): Promise<Array<string>> => {
  const out: Array<string> = [];
  for (const entry of pkg.files ?? []) {
    if (entry.startsWith("!") || entry === "src" || entry.startsWith("src/")) continue;
    const info = await stat(join(repo, entry)).catch(() => undefined);
    if (info?.isDirectory()) out.push(...(await walk(repo, entry)));
    else if (info !== undefined) out.push(entry);
  }
  return out.sort();
};

/**
 * `target`'s oxc-parser binding, the `.node` file the binary embeds: the installed one where
 * `bun install` put it, else downloaded from npm and checked against `bun.lock`'s integrity.
 */
const oxcBinding = (repo: string, target: BinaryTarget, lock: string, scratchDir: string) =>
  Effect.gen(function* () {
    const name = `@oxc-parser/binding-${target.oxcBinding}`;
    const file = `parser.${target.oxcBinding}.node`;
    const installed = join(repo, "node_modules", name, file);
    if (yield* Effect.promise(() => Bun.file(installed).exists())) return installed;
    const locked = lockedPackage(lock, name);
    if (locked === undefined)
      return yield* Effect.fail(fail("find in bun.lock", name, "no entry; run `bun install`"));
    const url = `https://registry.npmjs.org/${name}/-/binding-${target.oxcBinding}-${locked.version}.tgz`;
    const dir = join(scratchDir, `oxc-${target.oxcBinding}`);
    const tarball = `${dir}.tgz`;
    yield* Effect.tryPromise({
      try: async () => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
        if (integrity !== locked.integrity)
          throw new Error(`integrity ${integrity}, but bun.lock pins ${locked.integrity}`);
        await Bun.write(tarball, bytes);
        await mkdir(dir, { recursive: true });
      },
      catch: (cause) => fail("fetch", url, String(cause)),
    });
    yield* must(dir, ["tar", "xzf", tarball, "-C", dir]);
    return join(dir, "package", file);
  });

/** oxc-parser's own files, which `oxcForBinary` rewrites for the bundle. */
const OXC_SOURCE = /oxc-parser[\\/]src-js[\\/].*\.js$/;

const compile = (
  entry: string,
  target: BinaryTarget,
  binding: string,
  pkgPath: string,
  pkgText: string,
  outfile: string,
) =>
  Effect.tryPromise({
    try: async () => {
      let unloadable: string | undefined;
      const built = await Bun.build({
        entrypoints: [entry],
        // Without whitespace, the bundle has no comments naming each module by its path from
        // the directory the build ran in, so a commit's build is the same wherever it runs.
        minify: { whitespace: true },
        compile: { target: target.bunTarget as Bun.Build.CompileTarget, outfile },
        plugins: [
          {
            name: "mshape-binary",
            setup: (build) => {
              build.onLoad({ filter: OXC_SOURCE }, async ({ path }) => {
                const text = await Bun.file(path).text();
                const contents = oxcForBinary(path, text, binding);
                if (contents === undefined) unloadable = path;
                return { loader: "js", contents: contents ?? text };
              });
              // The CLI's version is the pack's, as in the embedded package.json.
              build.onLoad({ filter: /package\.json$/ }, ({ path }) =>
                path === pkgPath ? { loader: "json", contents: pkgText } : undefined,
              );
            },
          },
        ],
      });
      if (!built.success) throw new Error(built.logs.map(String).join("\n"));
      if (unloadable !== undefined)
        throw new Error(
          `${unloadable} no longer has the loader the binary replaces: ${OXC_LOADER}`,
        );
    },
    catch: (cause) =>
      fail(
        `compile for ${target.platform}`,
        entry,
        // A failed bundle throws every message it has, together.
        cause instanceof AggregateError ? cause.errors.map(String).join("\n") : String(cause),
      ),
  });

/**
 * Compiles `repo`'s working tree into one `mshape` per target in `destination`, with the
 * version `version` and the package's other files embedded, and `SHA256SUMS` beside them.
 * Returns the paths written, `SHA256SUMS` last.
 */
export const compileBinaries = (
  repoPath: string,
  destination: string,
  version: string,
  targets: ReadonlyArray<BinaryTarget> = BINARY_TARGETS,
) =>
  Effect.gen(function* () {
    const repo = resolve(repoPath);
    // Inside the repo, at a fixed path: the bundle names its modules by their path from the
    // directory holding them all, so a build of one commit doesn't depend on where it ran.
    const stage = join(repo, RELEASE_DIR, "binary");
    yield* remove(stage);
    yield* Effect.promise(() => mkdir(stage, { recursive: true }));
    return yield* Effect.gen(function* () {
      const pkg = yield* readPackage(repo);
      const pkgText = `${JSON.stringify({ ...pkg, version }, null, 2)}\n`;
      const lock = yield* Effect.promise(() => Bun.file(join(repo, "bun.lock")).text());
      const shipped = yield* Effect.promise(() => shippedFiles(repo, pkg));
      const files: ReadonlyArray<EmbeddedFile> = [
        { path: "package.json", source: join(stage, "package.json") },
        ...shipped.map((path) => ({ path, source: join(repo, path) })),
      ];
      yield* Effect.promise(() => Bun.write(join(stage, "package.json"), pkgText));
      // Names the directory the binary unpacks into: a new build of one version gets its own.
      const digest = yield* Effect.promise(async () => {
        const listing = new Bun.CryptoHasher("sha256");
        for (const file of files)
          listing.update(`${file.path}\0${sha256(await Bun.file(file.source).bytes())}\n`);
        return listing.digest("hex").slice(0, 16);
      });
      const entry = join(stage, "entry.ts");
      yield* Effect.promise(() =>
        Bun.write(entry, binaryEntry(files, join(repo, "src/cli/binary.ts"), version, digest)),
      );
      yield* Effect.promise(() => mkdir(destination, { recursive: true }));
      const digests = new Map<string, string>();
      for (const target of targets) {
        const binding = yield* oxcBinding(repo, target, lock, stage);
        const outfile = join(destination, binaryAsset(target));
        yield* compile(entry, target, binding, join(repo, "package.json"), pkgText, outfile);
        digests.set(binaryAsset(target), yield* fileDigest(outfile));
      }
      const sums = join(destination, SUMS_FILE);
      yield* Effect.promise(() => Bun.write(sums, sha256Sums(digests)));
      return [...[...digests.keys()].map((file) => join(destination, file)), sums];
    }).pipe(Effect.ensuring(remove(stage)));
  });
