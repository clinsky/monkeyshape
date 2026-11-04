/** The data every check reads and the findings it returns. Pure: no I/O lives here. */
import type { CheckName } from "../schemas/config.ts";

export type { CheckName } from "../schemas/config.ts";

type ViolationOf<C extends CheckName | "prerequisites"> = {
  /**
   * `prerequisites` are failures of the environment a check needs (a required integration
   * that can't run). They are never baselined and never skipped by `--only`.
   */
  readonly check: C;
  /** Namespaced by its check, e.g. `rules/no-throw`. Baselines and reports key on it. */
  readonly rule: `${C}/${string}`;
  /** Repo-relative path, `/`-separated. */
  readonly file: string;
  readonly line?: number;
  readonly message: string;
};

/** One finding; its `rule` always starts with its own `check`. */
export type Violation = { [C in CheckName | "prerequisites"]: ViolationOf<C> }[
  | CheckName
  | "prerequisites"];

/**
 * What a check reports beside its violations, so a green gate says what it looked at.
 * `passed` and `failed` follow from the violations left after the baseline; `examined`
 * names what the check ran over, in words. `unavailable` names the prerequisite that
 * couldn't run; it turns the gate red only when `required`.
 */
export type Outcome =
  | { readonly state: "passed"; readonly examined: string }
  | { readonly state: "failed"; readonly examined: string }
  | { readonly state: "not-applicable"; readonly reason: string }
  | {
      readonly state: "unavailable";
      readonly prerequisite: string;
      readonly reason: string;
      readonly required: boolean;
    }
  | { readonly state: "exempt"; readonly reason: string };

/** One check's result: its violations, and the one outcome they and its inputs make. */
export interface CheckReport {
  readonly check: CheckName;
  readonly outcome: Outcome;
  readonly violations: ReadonlyArray<Violation>;
  /** Parts a check runs separately, such as each declared command: one line each, under it. */
  readonly parts?: ReadonlyArray<{ readonly label: string; readonly outcome: Outcome }>;
}

/** What the beads check reads of a bead, from `bd list --json`. */
export interface BeadSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  /** bd's `issue_type`: `task`, `bug`, `feature`, `epic`. */
  readonly type: string;
  readonly labels: ReadonlyArray<string>;
}

/** What the checks see of the repo, loaded once by the workspace adapter. */
export interface Snapshot {
  /** Tracked and untracked-but-not-ignored files, repo-relative. */
  readonly files: ReadonlyArray<string>;
  /** Contents of the files checks read (sources, docs, configs), by path. */
  readonly texts: ReadonlyMap<string, string>;
  readonly packageScripts: ReadonlySet<string>;
  /** bd memories by key, when `integrations.beads` is ok. */
  readonly memories: ReadonlyMap<string, string> | undefined;
  /** Every bead id, open or closed, when `integrations.beads` is ok. */
  readonly beadIds: ReadonlySet<string> | undefined;
  /** Every bead, open or closed, when `integrations.beads` is ok: who owns what. */
  readonly beadRows?: ReadonlyArray<BeadSummary> | undefined;
  /** Files in a tsconfig program, as `tsc --listFilesOnly` reports them, when tsc ran. */
  readonly typechecked: ReadonlySet<string> | undefined;
  /** Files biome processes, as biome itself reports them, when biome ran. */
  readonly linted: ReadonlySet<string> | undefined;
  readonly integrations: Integrations;
  readonly skills: SkillsSnapshot;
  /** The `.beads/PRIME.md` the running monkeyshape ships, when it has one. */
  readonly shippedPrime: string | undefined;
  /** Files `mshape sync` manages that are on disk but not in `files`: git ignores them. */
  readonly unlisted: ReadonlySet<string>;
}

/** File bytes keyed by path relative to a skills directory: `<skill>/SKILL.md`. Bytes, so a
 * skill's images or binaries are copied and compared exactly. */
export type SkillFiles = ReadonlyMap<string, Uint8Array>;

/** What sits at `.claude/skills`: `target` is the link's own text, unresolved. */
export type SkillsLink =
  | { readonly kind: "missing" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "directory" }
  | { readonly kind: "other" };

/** The installed skills, read from disk, and the ones the running monkeyshape ships. */
export interface SkillsSnapshot {
  readonly link: SkillsLink;
  /** Files under `.agents/skills`. */
  readonly installed: SkillFiles;
  /** Files under `.claude/skills` when it is a real directory; empty otherwise. */
  readonly claudeDirectory: SkillFiles;
  /** Files under the package's `skills/`. */
  readonly shipped: SkillFiles;
}

/**
 * How an optional tool fared. `absent`: the repo doesn't use it. `unavailable`: it isn't
 * installed here (bd in CI). `failed`: it ran and broke, which is never silently skipped.
 */
export type Integration =
  | { readonly state: "ok" }
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly reason: string }
  | { readonly state: "failed"; readonly reason: string };

export interface Integrations {
  readonly beads: Integration;
  readonly tsc: Integration;
  readonly biome: Integration;
}

export const TS_SOURCE = /\.(ts|tsx|mts|cts)$/;

export const isTsSource = (path: string): boolean =>
  TS_SOURCE.test(path) && !path.endsWith(".d.ts");

/** Every directory that contains a file, plus the files themselves. */
export const pathIndex = (files: ReadonlyArray<string>): ReadonlySet<string> => {
  const index = new Set<string>();
  for (const file of files) {
    index.add(file);
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i++) index.add(segments.slice(0, i).join("/"));
  }
  return index;
};

export const lineCount = (text: string): number =>
  text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** 1-based line of a UTF-16 offset. */
export const lineAt = (text: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};
