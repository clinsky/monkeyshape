/** Loads the repo into a `Snapshot`: git's file list, the texts checks read, and what bd, tsc and biome report. */
import * as Effect from "effect/Effect";
import { PRIME_FILE } from "../core/conventions.ts";
import { parseJsonc } from "../core/coverage.ts";
import { parseDecisions } from "../core/decisions.ts";
import { SETTINGS_FILE } from "../core/hooks.ts";
import { type BeadSummary, classify, type Integration, type Snapshot } from "../core/model.ts";
import { SYNCED_FILES } from "../core/sync.ts";
import { PACKS } from "../packs/index.ts";
import type { LoadedPack, Pack, PackLoad, RepoView } from "../packs/pack.ts";
import { CHECK_NAMES, type CheckName, type ResolvedConfig } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { loadModes, runCommands } from "./commands.ts";
import { exists, readText } from "./disk.ts";
import { loadSizes, loadVendored } from "./files.ts";
import { LOADERS } from "./packs/index.ts";
import { BUN_MISSING, bunPath, run, runTool } from "./process.ts";
import { loadSkills } from "./skills.ts";

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
 * `bd bootstrap` sets the database up from the first source it can use, in this order:
 * `sync.remote` (committed in `.beads/config.yaml`, so a clone inherits it even when that
 * remote isn't reachable from here), git origin's `refs/dolt/data`, a backup under
 * `.beads/backup/`, then a committed `.beads/issues.jsonl`. Checks stay offline, so the note
 * can't say which source bd will reach. It names those the clone shows, in bd's order. With a
 * local one, bootstrap is safe whatever happens. Without one, bootstrap makes an empty
 * database that hides the beads unless they were pushed, to sync.remote or to origin, so the
 * note says how to test for pushed beads first.
 */
/** Remotes only Dolt speaks; any other sync.remote (a path, file, ssh, https) is a git remote. */
const DOLT_SCHEMES = /^(dolthub|aws|gs|oci):\/\//;

/** A word a POSIX shell reads back as itself: single-quoted when it holds anything special. */
const shellWord = (word: string): string =>
  /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;

export const noDatabaseNote = (sources: {
  readonly remote: string | undefined;
  readonly local: string | undefined;
}): string => {
  const { remote, local } = sources;
  if (local !== undefined)
    return remote === undefined
      ? `this clone has no beads database yet; run \`bd bootstrap\`, which rebuilds the database from ${local}`
      : `this clone has no beads database yet; run \`bd bootstrap\`. It uses the first source it can reach: the remote in sync.remote (${remote}), or else ${local} in this clone`;
  if (remote !== undefined) {
    // A committed sync.remote says where beads would be, not that they were pushed there.
    const git = DOLT_SCHEMES.test(remote) ? undefined : shellWord(remote.replace(/^git\+/, ""));
    const pushed =
      git === undefined
        ? `If the beads were pushed to ${remote} (sync.remote), run \`bd bootstrap\` to fetch them.`
        : `If \`git ls-remote ${git} refs/dolt/data\` prints a line, the beads were pushed to sync.remote: run \`bd bootstrap\` to fetch them.`;
    return `this clone has no beads database yet. ${pushed} If ${git === undefined ? "they weren't" : "it prints nothing, they weren't"}: don't run \`bd bootstrap\`, which would create an empty database and hide them; push them from a clone that has them with \`bd dolt push --yes\`, or work from that clone`;
  }
  return "this clone has no beads database yet. If `git ls-remote origin refs/dolt/data` prints a line, the beads were pushed: run `bd bootstrap` to fetch them. If it prints nothing, they are only on the machine that made them: don't run `bd bootstrap`, which would create an empty database and hide them; push them from a clone that has them with `bd dolt push --yes`, or work from that clone";
};

/** The local sources `bd bootstrap` can rebuild from, in its order: a backup, then the JSONL. */
const localBeads = (root: string) =>
  Effect.gen(function* () {
    const backups = yield* Effect.promise(() =>
      Array.fromAsync(new Bun.Glob(".beads/backup/*.jsonl").scan({ cwd: root })),
    ).pipe(Effect.orElseSucceed(() => []));
    const backup = [...backups].sort()[0];
    if (backup !== undefined) return backup;
    return (yield* exists(root, ".beads/issues.jsonl")) ? ".beads/issues.jsonl" : undefined;
  });

const noDatabase = (root: string) =>
  Effect.gen(function* () {
    const got = yield* runTool(root, ["bd", "config", "get", "sync.remote"]);
    const value = got.code === 0 ? (got.stdout.trim().split("\n").at(-1)?.trim() ?? "") : "";
    const remote = value === "" || value.includes("not set") ? undefined : value;
    return noDatabaseNote({ remote, local: yield* localBeads(root) });
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
 * `bun install` in a new worktree, so its gate is green with no manual step: frozen when a
 * lockfile is committed, as CI installs. Never fails: a worktree that couldn't install still
 * works, its gate using the main checkout's tools (`localBin`), and the line says so.
 * Undefined when there is no package.json to install.
 */
export const installDependencies = (dir: string) =>
  Effect.gen(function* () {
    if (!(yield* exists(dir, "package.json"))) return undefined;
    const locked = (yield* exists(dir, "bun.lock")) || (yield* exists(dir, "bun.lockb"));
    const args = ["install", ...(locked ? ["--frozen-lockfile"] : [])];
    const shown = `\`bun ${args.join(" ")}\``;
    const bun = bunPath();
    if (bun === undefined)
      return `note: ${shown} not run in ${dir}: ${BUN_MISSING}. Until then \`mshape check\` uses the main checkout's tsc and biome`;
    const result = yield* runTool(dir, [bun, ...args]);
    if (result.code === 0) return `ran ${shown} in ${dir}`;
    // bun prints its version first: the error line says why, else the last line does.
    const lines = `${result.stdout}\n${result.stderr}`
      .split("\n")
      .filter((line) => line.trim() !== "");
    const why = (lines.find((line) => line.startsWith("error:")) ?? lines.at(-1) ?? "").trim();
    // A drifted lockfile fails the same command again: the fix is a new lockfile, committed.
    const fix = why.includes("lockfile is frozen")
      ? "the lockfile is out of date with package.json: run `bun install` there and commit the lockfile it updates"
      : "fix what bun says, then run `bun install` there";
    return `note: ${shown} failed in ${dir} (exit ${result.code}${why === "" ? "" : `: ${why}`}); ${fix}. Until then \`mshape check\` uses the main checkout's tsc and biome`;
  });

/**
 * `packageRoot` is the running monkeyshape: its `skills/` and `template/.beads/PRIME.md` are
 * what a synced repo is compared with.
 */
/**
 * Each listed pack and what its loader found, in `packs` order. A pack this build doesn't
 * ship yet loads as nothing, so its files are reported as no listed pack's.
 */
const loadPacks = (
  root: string,
  config: ResolvedConfig,
  repo: RepoView,
  checks: ReadonlyArray<CheckName>,
) =>
  Effect.forEach(
    config.packs.flatMap((id) => {
      const pack = PACKS[id];
      return pack === undefined ? [] : [{ pack, loader: LOADERS[id] }];
    }),
    ({ pack, loader }) =>
      Effect.map(
        loader === undefined
          ? Effect.succeed<PackLoad>({ tools: [], outputs: new Map() })
          : loader({ root, config, repo, checks }),
        (load): LoadedPack => ({ pack, load }),
      ),
  );

/**
 * `checks` are the checks the caller will run: tsc, biome and the declared commands run only
 * when it holds `coverage`, since they can take minutes and nothing else reads them.
 */
export const loadSnapshot = (
  root: string,
  config: ResolvedConfig,
  packageRoot: string,
  { checks }: { readonly checks: ReadonlyArray<CheckName> } = { checks: CHECK_NAMES },
) =>
  Effect.gen(function* () {
    const coverage = checks.includes("coverage");
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
    const modes = yield* loadModes(root, present);
    const sizes = yield* loadSizes(root, present);
    // Source in other languages is read for its lines (budgets, garden), within the size cap:
    // past it, \`files\` already speaks for it, and a large binary needn't be read as text.
    const readable = (file: string) => (sizes.get(file) ?? 0) <= config.files.maxBytes;
    // A decision's enforcing files are read whatever they are, for the back-link to its slug.
    const decisionsText = present.includes("DECISIONS.md")
      ? yield* readText(root, "DECISIONS.md").pipe(Effect.orElseSucceed(() => ""))
      : "";
    const enforcing = parseDecisions(decisionsText).flatMap((d) =>
      d.enforcedBy.map((path) => path.replace(/\/$/, "")),
    );
    const enforces = (file: string) =>
      enforcing.some((path) => file === path || file.startsWith(`${path}/`));
    const wanted = present.filter(
      (file) =>
        Object.values(PACKS).some((pack) => pack?.kindOf(file) !== undefined) ||
        (enforces(file) && readable(file)) ||
        file.endsWith(".md") ||
        configs.has(file) ||
        classify(file, undefined) === "data" ||
        (classify(file, modes.get(file)) === "executable" && readable(file)),
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
    const loadedBeads = yield* beads(root);
    const packs = yield* loadPacks(root, config, { files: present, texts }, checks);
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
    const commands = coverage ? yield* runCommands(root, config, present) : new Map();
    const vendored = yield* loadVendored(root, config, present);
    const snapshot: Snapshot = {
      files: present,
      texts,
      packageScripts: new Set(scripts),
      memories: loadedBeads.value?.memories,
      beadIds: loadedBeads.value?.ids,
      beadRows: loadedBeads.value?.rows,
      integrations: { beads: loadedBeads.integration },
      packs,
      otherPacks: Object.values(PACKS).filter(
        (pack): pack is Pack => pack !== undefined && !config.packs.includes(pack.id),
      ),
      skills,
      shippedPrime,
      unlisted,
      modes,
      commands,
      sizes,
      vendored,
    };
    return snapshot;
  });
