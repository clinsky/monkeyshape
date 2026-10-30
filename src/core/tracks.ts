/**
 * The decisions behind `mshape track`: which shared paths are allowed, which directory is a
 * track, what `rm` may delete and in what order, and how `list` reads. Git and the filesystem
 * are read by `src/adapters/tracks.ts`, which hands the facts here.
 */
import {
  AGENTS_HANDOFFS_LINK,
  HANDOFFS_LINK,
  MAIN_BRANCH,
  TRACK_NAME,
  trackBranch,
  trackOf,
  WORKTREES_DIR,
  worktreePath,
} from "./layout.ts";

/** A worktree as `git worktree list --porcelain` reports it. */
export interface Worktree {
  readonly path: string;
  /** Short name, e.g. `track/docs`; undefined when detached or bare. */
  readonly branch: string | undefined;
  /** Registered, but its directory is gone: `git worktree prune` drops it. */
  readonly prunable: boolean;
}

export const parseWorktrees = (porcelain: string): ReadonlyArray<Worktree> =>
  porcelain
    .split(/\n\n+/)
    .map((block) => block.split("\n"))
    .flatMap((lines) => {
      const path = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
      const ref = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
      return path === undefined
        ? []
        : [
            {
              path,
              branch: ref?.startsWith("refs/heads/") ? ref.slice(11) : ref,
              prunable: lines.some((line) => line === "prunable" || line.startsWith("prunable ")),
            },
          ];
    });

export const nameProblem = (track: string): string | undefined =>
  TRACK_NAME.test(track)
    ? undefined
    : `\`${track}\` is not a track name: use lowercase words joined by hyphens, like \`docs\` or \`cross-module\``;

/**
 * `tracks.sharedPaths` as a whole. The schema has already made each entry normal; here the
 * entries must not repeat or nest, nor overlap what the track commands manage: `.git`, the
 * handoff links and the worktrees directory, which linked into a worktree would contain itself.
 */
export const sharedPathProblems = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);
  const problems: Array<string> = [];
  paths.forEach((path, index) => {
    if (paths.indexOf(path) !== index) problems.push(`\`${path}\` is listed twice`);
    for (const reserved of [".git", HANDOFFS_LINK, AGENTS_HANDOFFS_LINK, WORKTREES_DIR])
      if (within(path, reserved) || within(reserved, path))
        problems.push(
          `\`${path}\` overlaps \`${reserved}\`, which the track commands manage themselves: share something narrower`,
        );
    for (const other of paths)
      if (other !== path && within(path, other))
        problems.push(`\`${path}\` lies under \`${other}\`: list only \`${other}\``);
  });
  return problems.map((problem) => `tracks.sharedPaths in shape.config.ts: ${problem}`);
};

/** Why the directory `toplevel` is or is not a track: the name, or which check failed. */
export const currentTrack = (
  repo: string,
  toplevel: string,
  worktrees: ReadonlyArray<Worktree>,
): { readonly track: string } | { readonly reason: string } => {
  const track = trackOf(repo, toplevel);
  if (track === undefined)
    return {
      reason: `${toplevel} is not a track worktree: tracks live at ${worktreePath(repo, "<track>")}`,
    };
  const registered = worktrees.find((worktree) => worktree.path === toplevel);
  if (registered === undefined)
    return {
      reason: `${toplevel} is named like track \`${track}\`, but git has no worktree registered there for ${repo}`,
    };
  if (registered.branch !== trackBranch(track))
    return {
      reason: `${toplevel} is on ${registered.branch === undefined ? "a detached HEAD" : `branch \`${registered.branch}\``}, not \`${trackBranch(track)}\``,
    };
  return { track };
};

/** What `track rm` found, before touching anything. */
export interface RmFacts {
  readonly track: string;
  readonly worktreePath: string;
  /** The worktree git has registered at the track's path, if any. */
  readonly worktree: Worktree | undefined;
  /** Something is at the track's path on disk. */
  readonly pathExists: boolean;
  /** `git status --porcelain` lines in the worktree; empty when clean or gone. */
  readonly changes: ReadonlyArray<string>;
  /** Set when `git status` failed in the worktree: its changes can't be known. */
  readonly statusError: string | undefined;
  readonly branchExists: boolean;
  /** Commits on the branch that are not in `main`. */
  readonly unmerged: number;
  /** Other checkouts that have the branch checked out. */
  readonly branchCheckedOutAt: ReadonlyArray<Worktree>;
  readonly handoffPath: string;
  readonly handoffExists: boolean;
  readonly force: boolean;
  readonly keepHandoff: boolean;
}

export type RmStep =
  | { readonly kind: "worktree"; readonly path: string; readonly force: boolean }
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "handoff"; readonly path: string };

export interface RmPlan {
  /** Any refusal means nothing is touched. */
  readonly refusals: ReadonlyArray<string>;
  /** Said before the steps run: what `--force` is about to discard. */
  readonly warnings: ReadonlyArray<string>;
  /** In order: worktree, branch, handoff. `git worktree prune` follows them. */
  readonly steps: ReadonlyArray<RmStep>;
  /** What stays, and why, when nothing is wrong with keeping it. */
  readonly kept: ReadonlyArray<string>;
}

export const describeStep = (step: RmStep): string =>
  step.kind === "worktree"
    ? `worktree ${step.path}`
    : step.kind === "branch"
      ? `branch \`${step.name}\``
      : `handoff ${step.path}`;

/**
 * Only the track's own worktree, branch and handoff are ever candidates, so the main
 * checkout, other tracks and the handoff store are out of reach by construction. `--force`
 * overrides exactly two refusals: uncommitted changes and unmerged commits, both as listed.
 * Changes that can't be read are not changes the user agreed to discard.
 */
export const planRm = (facts: RmFacts): RmPlan => {
  const branch = trackBranch(facts.track);
  const refusals: Array<string> = [];
  const warnings: Array<string> = [];
  const kept: Array<string> = [];
  const steps: Array<RmStep> = [];

  if (
    facts.worktree === undefined &&
    !facts.pathExists &&
    !facts.branchExists &&
    !facts.handoffExists
  )
    return {
      refusals: [
        `there is no track \`${facts.track}\`: no worktree, no branch \`${branch}\`, no handoff`,
      ],
      warnings,
      steps,
      kept,
    };

  if (facts.worktree === undefined && facts.pathExists)
    refusals.push(
      `${facts.worktreePath} exists but git has no worktree registered there: look inside and remove it by hand`,
    );
  if (facts.worktree !== undefined && facts.worktree.branch !== branch)
    refusals.push(
      `the worktree at ${facts.worktreePath} is on ${facts.worktree.branch === undefined ? "a detached HEAD" : `\`${facts.worktree.branch}\``}, not \`${branch}\`: check it out there, or remove it by hand`,
    );
  for (const elsewhere of facts.branchCheckedOutAt)
    refusals.push(
      elsewhere.prunable
        ? `\`${branch}\` is still registered as checked out at ${elsewhere.path}, which no longer exists: run \`git worktree prune\`, then retry`
        : `\`${branch}\` is checked out at ${elsewhere.path}: switch that checkout to another branch first`,
    );
  if (facts.statusError !== undefined)
    refusals.push(
      `can't read the state of ${facts.worktreePath} (\`git status\` failed: ${facts.statusError}), so --force can't know what it would discard: inspect it by hand`,
    );

  if (facts.changes.length > 0) {
    const shown = facts.changes.slice(0, 5).join(", ");
    const more = facts.changes.length > 5 ? ` and ${facts.changes.length - 5} more` : "";
    if (facts.force)
      warnings.push(`discarding uncommitted changes in ${facts.worktreePath}: ${shown}${more}`);
    else
      refusals.push(
        `${facts.worktreePath} has uncommitted or untracked changes (${shown}${more}): commit or discard them, or pass --force to discard them`,
      );
  }
  if (facts.branchExists && facts.unmerged > 0) {
    if (facts.force)
      warnings.push(
        `deleting \`${branch}\` with ${facts.unmerged} commit(s) not in \`${MAIN_BRANCH}\``,
      );
    else
      refusals.push(
        `\`${branch}\` has ${facts.unmerged} commit(s) not in \`${MAIN_BRANCH}\`: merge them, or if they were merged upstream update \`${MAIN_BRANCH}\` (\`git fetch origin ${MAIN_BRANCH}:${MAIN_BRANCH}\`), or pass --force to delete them`,
      );
  }

  if (facts.worktree !== undefined)
    steps.push({ kind: "worktree", path: facts.worktreePath, force: facts.force });
  if (facts.branchExists) steps.push({ kind: "branch", name: branch });
  if (facts.handoffExists) {
    if (facts.keepHandoff) kept.push(`handoff ${facts.handoffPath} (--keep-handoff)`);
    else steps.push({ kind: "handoff", path: facts.handoffPath });
  }
  return refusals.length > 0
    ? { refusals, warnings: [], steps: [], kept: [] }
    : { refusals, warnings, steps, kept };
};

/** One line per track in `track list`. */
export interface TrackRow {
  readonly track: string;
  readonly status: "stub" | "active" | "invalid" | "none";
  /** Commits not in `main`; undefined without a branch. */
  readonly ahead: number | undefined;
  /** Relative to the main checkout; undefined without a worktree. */
  readonly worktree: string | undefined;
  /** Set when the worktree is on another branch than `track/<track>`. */
  readonly worktreeBranch?: string | undefined;
}

export const formatTracks = (rows: ReadonlyArray<TrackRow>): string => {
  if (rows.length === 0) return "no tracks: start one with `mshape track new <name>`";
  const table = [
    ["track", "status", "ahead", "merged", "worktree"],
    ...rows.map((row) => [
      row.track,
      row.status,
      row.ahead === undefined ? "-" : String(row.ahead),
      row.ahead === undefined ? "-" : row.ahead === 0 ? "yes" : "no",
      row.worktree === undefined
        ? "-"
        : row.worktreeBranch === undefined
          ? row.worktree
          : `${row.worktree} (on ${row.worktreeBranch})`,
    ]),
  ];
  const widths =
    table[0]?.map((_, column) => Math.max(...table.map((cells) => cells[column]?.length ?? 0))) ??
    [];
  return table
    .map((cells) =>
      cells
        .map((cell, column) =>
          column === cells.length - 1 ? cell : cell.padEnd((widths[column] ?? 0) + 2),
        )
        .join(""),
    )
    .join("\n");
};
