/** The data every check reads and the findings it returns. Pure: no I/O lives here. */

export type CheckName = "arch" | "refs" | "budgets" | "coverage" | "rules" | "skills";

export interface Violation {
  /**
   * `prerequisites` are failures of the environment a check needs (a required integration
   * that can't run). They are never baselined and never skipped by `--only`.
   */
  readonly check: CheckName | "prerequisites";
  /** Namespaced, e.g. `rules/no-throw`. Baselines and reports key on it. */
  readonly rule: string;
  /** Repo-relative path, `/`-separated. */
  readonly file: string;
  readonly line?: number;
  readonly message: string;
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
  /** Files in a tsconfig program, as `tsc --listFilesOnly` reports them, when tsc ran. */
  readonly typechecked: ReadonlySet<string> | undefined;
  /** Files biome processes, as biome itself reports them, when biome ran. */
  readonly linted: ReadonlySet<string> | undefined;
  readonly integrations: Integrations;
  readonly skills: SkillsSnapshot;
}

/** Files keyed by path relative to a skills directory: `<skill>/SKILL.md`. */
export type SkillFiles = ReadonlyMap<string, string>;

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
