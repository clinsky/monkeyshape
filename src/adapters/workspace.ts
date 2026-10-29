/** Loads the repo into a `Snapshot`: git's file list, the texts checks read, and what bd, tsc and biome report. */
import { realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { Effect } from "effect";
import { parseJsonc } from "../core/coverage.ts";
import { type Integration, isTsSource, type Snapshot } from "../core/model.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";

const run = (root: string, command: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...command], { cwd: root, stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(child.stdout).text();
      return { stdout, code: await child.exited };
    },
    catch: (cause) =>
      new WorkspaceError({ operation: "run", path: command.join(" "), reason: String(cause) }),
  });

/** For optional tools: a spawn failure is an exit code to report, not a reason to abort. */
const runTool = (root: string, command: ReadonlyArray<string>) =>
  run(root, command).pipe(Effect.orElseSucceed(() => ({ stdout: "", code: -1 })));

export const readText = (root: string, path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(`${root}/${path}`).text(),
    catch: (cause) => new WorkspaceError({ operation: "read", path, reason: String(cause) }),
  });

/** Files and directories alike: git lists a submodule as one entry, and it is a directory. */
const exists = (root: string, path: string) =>
  Effect.promise(() =>
    stat(`${root}/${path}`).then(
      () => true,
      () => false,
    ),
  );

const listFiles = (root: string) =>
  Effect.gen(function* () {
    const result = yield* run(root, [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (result.code !== 0)
      return yield* Effect.fail(
        new WorkspaceError({ operation: "list", path: root, reason: "not a git repository" }),
      );
    // Nested repositories and worktrees show up as a directory entry; they are not ours.
    return result.stdout.split("\0").filter((file) => file !== "" && !file.endsWith("/"));
  });

type Loaded<A> = { readonly integration: Integration; readonly value: A | undefined };

const failed = <A>(reason: string): Loaded<A> => ({
  integration: { state: "failed", reason },
  value: undefined,
});

const jsonRows = (stdout: string): ReadonlyArray<unknown> | undefined => {
  const parsed = parseJsonc(stdout);
  // `bd list --limit 0 --json` wraps the rows as `{ issues: [...] }`; limited lists are bare.
  const rows =
    typeof parsed === "object" && parsed !== null && "issues" in parsed ? parsed.issues : parsed;
  return Array.isArray(rows) ? rows : undefined;
};

/** bd memories and every bead id. A repo without `.beads` is absent; bd missing is unavailable. */
const beads = (root: string) =>
  Effect.gen(function* () {
    type Value = { memories: ReadonlyMap<string, string>; ids: ReadonlySet<string> };
    if (!(yield* exists(root, ".beads/config.yaml")))
      return { integration: { state: "absent" }, value: undefined } satisfies Loaded<Value>;
    if (Bun.which("bd") === null)
      return {
        integration: { state: "unavailable", reason: "bd is not on PATH" },
        value: undefined,
      } satisfies Loaded<Value>;
    const memories = yield* runTool(root, ["bd", "memories", "--json"]);
    const parsedMemories = memories.code === 0 ? parseJsonc(memories.stdout) : undefined;
    if (typeof parsedMemories !== "object" || parsedMemories === null)
      return failed<Value>(`\`bd memories --json\` exited ${memories.code} or printed no object`);
    const list = yield* runTool(root, [
      "bd",
      "list",
      "--all",
      "--brief",
      "--skip-labels",
      "--limit",
      "0",
      "--json",
    ]);
    const rows = list.code === 0 ? jsonRows(list.stdout) : undefined;
    if (rows === undefined)
      return failed<Value>(`\`bd list --json\` exited ${list.code} or printed no rows`);
    const value: Value = {
      memories: new Map(
        Object.entries(parsedMemories).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      ids: new Set(
        rows.flatMap((issue) =>
          typeof issue === "object" &&
          issue !== null &&
          "id" in issue &&
          typeof issue.id === "string"
            ? [issue.id]
            : [],
        ),
      ),
    };
    return { integration: { state: "ok" }, value } satisfies Loaded<Value>;
  });

/**
 * A tool installed in the repo, as a command. Run through the current bun: the bin shims
 * start with `#!/usr/bin/env node`, and a Bun-only machine has no node.
 */
const localBin = (root: string, name: string) =>
  Effect.map(exists(root, `node_modules/.bin/${name}`), (found) =>
    found ? [process.execPath, `${root}/node_modules/.bin/${name}`] : undefined,
  );

/**
 * The tsconfigs a project's references point at. A reference names a tsconfig file or a
 * directory holding `tsconfig.json`; references are not inherited through `extends`, so the
 * file's own JSON is the whole answer. Unreadable files yield none; tsc reports them itself.
 */
const referencesOf = (root: string, tsconfig: string) =>
  Effect.gen(function* () {
    const text = yield* readText(root, tsconfig).pipe(Effect.orElseSucceed(() => "{}"));
    const parsed = parseJsonc(text);
    const references =
      typeof parsed === "object" && parsed !== null && "references" in parsed
        ? parsed.references
        : undefined;
    if (!Array.isArray(references)) return [];
    const out: Array<string> = [];
    for (const reference of references) {
      if (typeof reference !== "object" || reference === null || !("path" in reference)) continue;
      if (typeof reference.path !== "string") continue;
      const target = posix.normalize(posix.join(posix.dirname(tsconfig), reference.path));
      const isDirectory = yield* Effect.promise(() =>
        stat(`${root}/${target}`).then(
          (info) => info.isDirectory(),
          () => false,
        ),
      );
      out.push(isDirectory ? posix.join(target, "tsconfig.json") : target);
    }
    return out;
  });

/**
 * The union of every configured tsconfig's program and, transitively, of every project it
 * references, as tsc itself resolves each one. `tsc -p` checks one project and `--build`
 * won't list files, so the reference graph is walked here, each project once.
 */
const typechecked = (root: string, realRoot: string, tsconfigs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const tsc = yield* localBin(root, "tsc");
    if (tsc === undefined)
      return {
        integration: { state: "unavailable", reason: "typescript is not installed" },
        value: undefined,
      } satisfies Loaded<ReadonlySet<string>>;
    const files = new Set<string>();
    const seen = new Set<string>();
    const queue = tsconfigs.map((tsconfig) => posix.normalize(tsconfig));
    for (let tsconfig = queue.shift(); tsconfig !== undefined; tsconfig = queue.shift()) {
      if (seen.has(tsconfig)) continue;
      seen.add(tsconfig);
      const result = yield* runTool(root, [...tsc, "-p", tsconfig, "--listFilesOnly"]);
      if (result.code !== 0)
        return failed<ReadonlySet<string>>(
          `\`tsc -p ${tsconfig} --listFilesOnly\` exited ${result.code}`,
        );
      for (const line of result.stdout.split("\n"))
        if (line.startsWith(`${realRoot}/`)) files.add(line.slice(realRoot.length + 1));
      queue.push(...(yield* referencesOf(root, tsconfig)));
    }
    return { integration: { state: "ok" }, value: files } satisfies Loaded<ReadonlySet<string>>;
  });

/** The files biome processes, from its verbose report, with `extends` and ignores resolved. */
const linted = (root: string) =>
  Effect.gen(function* () {
    const biome = yield* localBin(root, "biome");
    if (biome === undefined)
      return {
        integration: { state: "unavailable", reason: "@biomejs/biome is not installed" },
        value: undefined,
      } satisfies Loaded<ReadonlySet<string>>;
    const result = yield* runTool(root, [
      ...biome,
      "lint",
      "--verbose",
      "--colors=off",
      "--max-diagnostics=0",
      ".",
    ]);
    const report = result.stdout.split("Files processed:")[1];
    if (report === undefined)
      return failed<ReadonlySet<string>>(
        `\`biome lint --verbose\` printed no "Files processed:" list (exit ${result.code})`,
      );
    const files = new Set(
      report.split("\n").flatMap((line) => {
        const match = /^\s+- (.+)$/.exec(line);
        return match?.[1] === undefined ? [] : [match[1].trim()];
      }),
    );
    return { integration: { state: "ok" }, value: files } satisfies Loaded<ReadonlySet<string>>;
  });

export const loadSnapshot = (root: string, config: ResolvedConfig) =>
  Effect.gen(function* () {
    const listed = yield* listFiles(root);
    // A file deleted but not yet staged is still listed; it isn't part of the repo now.
    const found = yield* Effect.forEach(listed, (file) => exists(root, file), { concurrency: 32 });
    const present = listed.filter((_, i) => found[i] === true);
    const configs = new Set([...config.coverage.tsconfigs, config.coverage.biome, "package.json"]);
    const wanted = present.filter(
      (file) => isTsSource(file) || file.endsWith(".md") || configs.has(file),
    );
    const texts = new Map(
      yield* Effect.forEach(
        wanted,
        (file) => Effect.map(readText(root, file), (text) => [file, text] as const),
        {
          concurrency: 32,
        },
      ),
    );
    const manifest = parseJsonc(texts.get("package.json") ?? "{}");
    const scripts =
      typeof manifest === "object" &&
      manifest !== null &&
      "scripts" in manifest &&
      typeof manifest.scripts === "object"
        ? Object.keys(manifest.scripts ?? {})
        : [];
    const realRoot = yield* Effect.promise(() => realpath(root));
    const loadedBeads = yield* beads(root);
    const loadedTsc = yield* typechecked(root, realRoot, config.coverage.tsconfigs);
    const loadedBiome = yield* linted(root);
    const snapshot: Snapshot = {
      files: present,
      texts,
      packageScripts: new Set(scripts),
      memories: loadedBeads.value?.memories,
      beadIds: loadedBeads.value?.ids,
      typechecked: loadedTsc.value,
      linted: loadedBiome.value,
      integrations: {
        beads: loadedBeads.integration,
        tsc: loadedTsc.integration,
        biome: loadedBiome.integration,
      },
    };
    return snapshot;
  });
