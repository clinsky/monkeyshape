/** The data every check reads and the findings it returns. Pure: no I/O lives here. */

export type CheckName = "arch" | "refs" | "budgets" | "coverage" | "rules";

export interface Violation {
  readonly check: CheckName;
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
  /** bd memories by key, when the repo uses beads and `bd` answered. */
  readonly memories: ReadonlyMap<string, string> | undefined;
  /** Every bead id, open or closed, when the repo uses beads and `bd` answered. */
  readonly beadIds: ReadonlySet<string> | undefined;
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
