/** Loads the repo into a `Snapshot`: git's file list, the texts checks read, and what bd, tsc and biome report. */
import { realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import { Effect } from "effect";
import { PRIME_FILE } from "../core/conventions.ts";
import { parseJsonc } from "../core/coverage.ts";
import { SETTINGS_FILE } from "../core/hooks.ts";
import { type BeadSummary, type Integration, isTsSource, type Snapshot } from "../core/model.ts";
import { SYNCED_FILES } from "../core/sync.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { run, runTool } from "./process.ts";
import { loadSkills } from "./skills.ts";

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

/**
 * Why a clone without a beads database can't read its beads, and the fix that works here.
 * `bd bootstrap` recovers beads only from where they were pushed: `sync.remote`, committed in
 * `.beads/config.yaml` so a clone can read it, or `refs/dolt/data` on git origin, which
 * `bd dolt push` writes without committing anything, so only the remote can say. Checks stay
 * offline, so the message holds that test; without either source bootstrap makes an empty
 * database that hides the beads.
 */
const noDatabase = (root: string) =>
  Effect.map(runTool(root, ["bd", "config", "get", "sync.remote"]), (got) => {
    const remote = got.code === 0 ? (got.stdout.trim().split("\n").at(-1)?.trim() ?? "") : "";
    return remote !== "" && !remote.includes("not set")
      ? `this clone has no beads database yet; run \`bd bootstrap\`, which fetches the beads from ${remote}`
      : "this clone has no beads database yet. If `git ls-remote origin refs/dolt/data` prints a line, the beads were pushed: run `bd bootstrap` to fetch them. If it prints nothing, they are only on the machine that made them: don't run `bd bootstrap`, which would create an empty database and hide them; push them from a clone that has them with `bd dolt push --yes`, or work from that clone";
  });

/** Whether bd can be asked: absent without `.beads/config.yaml`, unavailable without bd. */
const beadsUnreachable = (root: string) =>
  Effect.gen(function* () {
    if (!(yield* exists(root, ".beads/config.yaml")))
      return { state: "absent" } satisfies Integration;
    if (Bun.which("bd") === null)
      return { state: "unavailable", reason: "bd is not on PATH" } satisfies Integration;
    // A fresh clone has .beads/ but no database: bd knows where it would be, but has none.
    // Its beads exist and can't be read here; that is unavailable, not bd failing.
    const where = yield* runTool(root, ["bd", "where", "--json"]);
    const located = where.code === 0 ? parseJsonc(where.stdout) : undefined;
    if (
      typeof located === "object" &&
      located !== null &&
      "path" in located &&
      !("database_path" in located)
    )
      return { state: "unavailable", reason: yield* noDatabase(root) } satisfies Integration;
    return undefined;
  });

/**
 * Every bead `bd list --all <filters> --json` prints, with the integration state `check` and
 * `track` both read: absent, unavailable, failed (bd ran and failed, its stderr kept) or ok.
 */
export const beadRows = (root: string, filters: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const unreachable = yield* beadsUnreachable(root);
    if (unreachable !== undefined)
      return { integration: unreachable, value: undefined } satisfies Loaded<
        ReadonlyArray<unknown>
      >;
    const command = ["bd", "list", "--all", ...filters, "--limit", "0", "--json"];
    // A spawn that throws is bd failing to run: reported as failed, never an abort.
    const result = yield* Effect.try(() =>
      Bun.spawnSync(command, { cwd: root, stdout: "pipe", stderr: "pipe" }),
    ).pipe(Effect.orElseSucceed(() => undefined));
    const rows = result?.exitCode === 0 ? jsonRows(result.stdout.toString()) : undefined;
    if (rows === undefined) {
      const stderr = result?.stderr.toString().trim() ?? "";
      return failed<ReadonlyArray<unknown>>(
        `\`${command.join(" ")}\` exited ${result?.exitCode ?? "without running"} or printed no rows${stderr === "" ? "" : `: ${stderr}`}`,
      );
    }
    return { integration: { state: "ok" }, value: rows } satisfies Loaded<ReadonlyArray<unknown>>;
  });

/** bd memories and every bead id. A repo without `.beads` is absent; bd missing is unavailable. */
const beads = (root: string) =>
  Effect.gen(function* () {
    type Value = {
      memories: ReadonlyMap<string, string>;
      ids: ReadonlySet<string>;
      rows: ReadonlyArray<BeadSummary>;
    };
    const unreachable = yield* beadsUnreachable(root);
    if (unreachable !== undefined)
      return { integration: unreachable, value: undefined } satisfies Loaded<Value>;
    const memories = yield* runTool(root, ["bd", "memories", "--json"]);
    const parsedMemories = memories.code === 0 ? parseJsonc(memories.stdout) : undefined;
    if (typeof parsedMemories !== "object" || parsedMemories === null)
      return failed<Value>(`\`bd memories --json\` exited ${memories.code} or printed no object`);
    // Labels and types too: the beads check reads who owns each bead.
    const list = yield* beadRows(root, ["--brief"]);
    const rows = list.value;
    if (rows === undefined)
      return { integration: list.integration, value: undefined } satisfies Loaded<Value>;
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
      rows: rows.flatMap((issue) => {
        const { id, title, status, issue_type, labels } = (issue ?? {}) as Record<string, unknown>;
        return typeof id === "string" && typeof status === "string"
          ? [
              {
                id,
                title: typeof title === "string" ? title : "",
                status,
                type: typeof issue_type === "string" ? issue_type : "",
                labels: Array.isArray(labels)
                  ? labels.filter((label): label is string => typeof label === "string")
                  : [],
              },
            ]
          : [];
      }),
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

/**
 * `packageRoot` is the running monkeyshape: its `skills/` and `template/.beads/PRIME.md` are
 * what a synced repo is compared with.
 */
export const loadSnapshot = (root: string, config: ResolvedConfig, packageRoot: string) =>
  Effect.gen(function* () {
    const listed = yield* listFiles(root);
    // A file deleted but not yet staged is still listed; it isn't part of the repo now.
    const found = yield* Effect.forEach(listed, (file) => exists(root, file), { concurrency: 32 });
    const present = listed.filter((_, i) => found[i] === true);
    const configs = new Set([
      ...config.coverage.tsconfigs,
      config.coverage.biome,
      "package.json",
      SETTINGS_FILE,
    ]);
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
    const skills = yield* loadSkills(`${packageRoot}/skills`, root);
    const shippedPrime = yield* Effect.promise(() =>
      Bun.file(`${packageRoot}/template/${PRIME_FILE}`)
        .text()
        .catch(() => undefined),
    );
    const listedNow = new Set(present);
    const unlisted = new Set<string>();
    for (const file of SYNCED_FILES)
      if (!listedNow.has(file) && (yield* exists(root, file))) unlisted.add(file);
    const snapshot: Snapshot = {
      files: present,
      texts,
      packageScripts: new Set(scripts),
      memories: loadedBeads.value?.memories,
      beadIds: loadedBeads.value?.ids,
      beadRows: loadedBeads.value?.rows,
      typechecked: loadedTsc.value,
      linted: loadedBiome.value,
      integrations: {
        beads: loadedBeads.integration,
        tsc: loadedTsc.integration,
        biome: loadedBiome.integration,
      },
      skills,
      shippedPrime,
      unlisted,
    };
    return snapshot;
  });
