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
  /** The files in `files` that aren't plain: git's mode when tracked, the disk's otherwise. */
  readonly modes: ReadonlyMap<string, FileMode>;
  /**
   * Each declared command's run, by its index in `coverage.commands`. A command whose files
   * match nothing isn't run, and has no entry.
   */
  readonly commands: ReadonlyMap<number, CommandRun>;
  /** Each file's size in bytes, by path; a symlink's is the link's own. */
  readonly sizes: ReadonlyMap<string, number>;
  /** What each recorded vendored artifact is, by its recorded path, when it is in `files`. */
  readonly vendored: ReadonlyMap<string, VendoredRead>;
}

/**
 * A vendored artifact as read from disk: its digest, and the name in its
 * `package/package.json`, or why that name can't be read (not an archive, no manifest).
 */
export interface VendoredRead {
  readonly sha256: string;
  readonly package: { readonly name: string } | { readonly unreadable: string };
}

/** Git's executable bit (mode 100755) or a symlink (120000). */
export type FileMode = "executable" | "symlink";

/**
 * How a declared command fared. `unavailable`: its program isn't installed here, or it
 * exited 127 saying a program was "not found" or "not installed" (a shell, or a wrapper
 * script missing its toolchain). Otherwise it ran: exit 0 passes, any other code fails,
 * including 127 for a missing file.
 */
export type CommandRun =
  | { readonly state: "ran"; readonly code: number; readonly output: string }
  | { readonly state: "unavailable"; readonly reason: string };

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

/**
 * Source in a language monkeyshape doesn't analyze: a declared command must check it, or a
 * reason must exempt it. With the executable bit, the extension doesn't matter.
 */
export const EXECUTABLE_EXTENSIONS: ReadonlyArray<string> = [
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "py",
  "sh",
  "bash",
  "java",
  "go",
  "rs",
  "rb",
  "js",
  "mjs",
  "cjs",
];

/** Structured data, parsed with Bun's own parsers. */
export const DATA_EXTENSIONS: ReadonlyArray<string> = ["json", "jsonc", "yaml", "yml", "toml"];

/** git's own files, by name in any directory. Never `.git*`: `.github/` holds code. */
const GIT_FILES = new Set([".gitignore", ".gitattributes", ".gitmodules", ".gitkeep"]);

/**
 * What a file is to the gate. `builtin`: another tool owns it (bd's `.beads/`, git's own
 * files, symlinks, whose target is classified where it lives). `typescript`: the deep
 * checks. `executable`: source in another language, which a declared command covers.
 * `data`: must parse. `metadata`: everything else (docs, lockfiles, licences, images, other
 * assets), held only to the size cap.
 */
export type FileClass = "builtin" | "typescript" | "executable" | "data" | "metadata";

const extension = (path: string): string => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
};

export const classify = (path: string, mode: FileMode | undefined): FileClass => {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (mode === "symlink" || path.startsWith(".beads/") || GIT_FILES.has(name)) return "builtin";
  if (TS_SOURCE.test(path)) return "typescript";
  const ext = extension(path);
  if (mode === "executable" || EXECUTABLE_EXTENSIONS.includes(ext)) return "executable";
  if (DATA_EXTENSIONS.includes(ext)) return "data";
  return "metadata";
};

export const isTsSource = (path: string): boolean =>
  TS_SOURCE.test(path) && !path.endsWith(".d.ts");

/**
 * Source whose lines count: TypeScript, and executable source in any language whose text was
 * read and isn't binary (a NUL byte: a compiled artifact with the executable bit), outside the
 * segments coverage exempts, so budgets and coverage agree on what is the repo's own.
 */
export const lineSources = (
  snapshot: Snapshot,
  /** `coverage.exempt`: generated or vendored code is not the repo's to split. */
  exempt: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  snapshot.files.filter((file) => {
    if (file.split("/").some((segment) => exempt.includes(segment))) return false;
    const kind = classify(file, snapshot.modes.get(file));
    if (kind === "typescript") return isTsSource(file);
    if (kind !== "executable") return false;
    const text = snapshot.texts.get(file);
    return text !== undefined && !text.includes("\0");
  });

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
