/**
 * The decisions behind `mshape track`: which shared paths are allowed, which directory is a
 * track, what `rm` may delete and in what order, and how `list` reads. Git and the filesystem
 * are read by `src/adapters/tracks.ts`, which hands the facts here.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { beadsBlocker } from "./check.ts";
import {
  AGENTS_HANDOFFS_LINK,
  HANDOFFS_LINK,
  TRACK_NAME,
  trackBranch,
  trackLabel,
  trackOf,
  WORKTREES_DIR,
  worktreePath,
} from "./layout.ts";
import type { Integration } from "./model.ts";

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

/** A bead that isn't closed, as `bd list --json` reports it. */
export interface OpenBead {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

/**
 * Beads that aren't closed, by the track each `track:<name>` label names: a bead labelled for
 * two tracks belongs to both. Rows that aren't beads are skipped.
 */
export const openBeadsByTrack = (
  rows: ReadonlyArray<unknown>,
): ReadonlyMap<string, ReadonlyArray<OpenBead>> => {
  const byTrack = new Map<string, Array<OpenBead>>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const { id, title, status, labels } = row as Record<string, unknown>;
    if (typeof id !== "string" || status === "closed" || !Array.isArray(labels)) continue;
    const bead = {
      id,
      title: typeof title === "string" ? title : "",
      status: typeof status === "string" ? status : "unknown",
    };
    for (const label of labels) {
      const track = typeof label === "string" ? /^track:(.+)$/.exec(label)?.[1] : undefined;
      if (track !== undefined && TRACK_NAME.test(track))
        byTrack.set(track, [...(byTrack.get(track) ?? []), bead]);
    }
  }
  return byTrack;
};

/**
 * What beads said about a track's open work: the integration state `mshape check` uses, the
 * config's `beads` setting, and, when the state is ok, the track's beads that aren't closed.
 */
export interface BeadsCheck {
  readonly integration: Integration;
  readonly setting: ResolvedConfig["beads"];
  readonly open: ReadonlyArray<OpenBead>;
}

/**
 * The track's mailbox (`mshape msg`): each unread message, by id and a line saying what it is
 * (its sender and subject, or why its file can't be read), and how many were read.
 */
export interface MailboxFacts {
  readonly path: string;
  readonly exists: boolean;
  readonly unread: ReadonlyArray<{ readonly id: string; readonly about: string }>;
  readonly read: number;
}

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
  /** Commits on the branch in none of `mergeTargets`. */
  readonly unmerged: number;
  /** The branch's work is in a target anyway: merged, rebased or squashed there. */
  readonly merged: boolean;
  /** What counts as merged, as people say them: `main`, and `origin/main` when it exists. */
  readonly mergeTargets: ReadonlyArray<string>;
  /** Other checkouts that have the branch checked out. */
  readonly branchCheckedOutAt: ReadonlyArray<Worktree>;
  readonly handoffPath: string;
  readonly handoffExists: boolean;
  /** Beads labelled `track:<track>` that aren't closed: removing the track would orphan them. */
  readonly beads: BeadsCheck;
  readonly mailbox: MailboxFacts;
  readonly force: boolean;
  readonly keepHandoff: boolean;
}

export type RmStep =
  | { readonly kind: "worktree"; readonly path: string; readonly force: boolean }
  | { readonly kind: "branch"; readonly name: string }
  | { readonly kind: "handoff"; readonly path: string }
  | {
      readonly kind: "mailbox";
      readonly path: string;
      readonly unread: number;
      readonly read: number;
    };

export interface RmPlan {
  /** Any refusal means nothing is touched. */
  readonly refusals: ReadonlyArray<string>;
  /** Said before the steps run: what `--force` is about to discard. */
  readonly warnings: ReadonlyArray<string>;
  /** In order: worktree, branch, handoff, mailbox. `git worktree prune` follows them. */
  readonly steps: ReadonlyArray<RmStep>;
  /** What stays, and why, when nothing is wrong with keeping it. */
  readonly kept: ReadonlyArray<string>;
  /** Said whether or not it refuses: a check that couldn't run. */
  readonly notes: ReadonlyArray<string>;
}

export const describeStep = (step: RmStep): string =>
  step.kind === "worktree"
    ? `worktree ${step.path}`
    : step.kind === "branch"
      ? `branch \`${step.name}\``
      : step.kind === "handoff"
        ? `handoff ${step.path}`
        : `mailbox ${step.path} (${step.unread} unread, ${step.read} read)`;

/**
 * Only the track's own worktree, branch, handoff and mailbox are ever candidates, so the main
 * checkout, other tracks and the handoff store are out of reach by construction. `--force`
 * overrides exactly three refusals: uncommitted changes, unmerged commits and unread mail, each
 * as listed. The mailbox goes with the handoff, so a later track of the same name starts with
 * neither; `--keep-handoff` keeps both, for a track that continues.
 * Changes that can't be read are not changes the user agreed to discard. Open beads are never
 * overridden: closing or moving each one is a single command, and removing the track would
 * leave them with no one to do them.
 */
export const planRm = (facts: RmFacts): RmPlan => {
  const branch = trackBranch(facts.track);
  const refusals: Array<string> = [];
  const warnings: Array<string> = [];
  const kept: Array<string> = [];
  const steps: Array<RmStep> = [];
  const label = trackLabel(facts.track);
  const notes: Array<string> = [];
  const listBeads = `bd list --label ${label} --status open,in_progress,blocked,deferred`;
  const { integration, setting, open } = facts.beads;
  const blocker = beadsBlocker(setting, integration);
  if (blocker === undefined && integration.state === "absent")
    notes.push("this repo has no beads (no .beads/), so open beads were not checked");
  if (blocker === undefined && integration.state === "unavailable")
    notes.push(
      `open beads were not checked: ${integration.reason}. Check by hand with \`${listBeads}\``,
    );

  if (
    facts.worktree === undefined &&
    !facts.pathExists &&
    !facts.branchExists &&
    !facts.handoffExists &&
    !facts.mailbox.exists
  )
    return {
      refusals: [
        `there is no track \`${facts.track}\`: no worktree, no branch \`${branch}\`, no handoff`,
      ],
      warnings,
      steps,
      kept,
      notes: [],
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
  if (integration.state === "ok" && open.length > 0)
    refusals.push(
      [
        `\`${label}\` still labels ${open.length} bead(s) that aren't closed, and removing the track would orphan them:`,
        ...open.map((bead) => `  ${bead.id} (${bead.status}) ${bead.title}`),
        `close each one that's done (\`bd close <id>\`), or move it to the track that will do it (\`bd update <id> --remove-label ${label} --add-label track:<other>\`). --force doesn't override this`,
      ].join("\n    "),
    );
  // A failing bd hides the beads, so there is nothing for --force to agree to discard.
  if (blocker === "failed" && integration.state === "failed")
    refusals.push(
      `bd failed, so the open beads labelled \`${label}\` can't be seen: ${integration.reason}. Get \`bd\` working, then retry; --force doesn't override this`,
    );
  if (blocker === "required")
    refusals.push(
      integration.state === "absent"
        ? `shape.config.ts requires beads, but the repo has no .beads/config.yaml, so the open beads labelled \`${label}\` can't be checked: set beads up, or set \`beads: "optional"\``
        : `shape.config.ts requires beads, but ${"reason" in integration ? integration.reason : "it didn't answer"}, so the open beads labelled \`${label}\` can't be checked: get \`bd\` working, then retry`,
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
  if (facts.branchExists && !facts.merged) {
    const targets = facts.mergeTargets.map((target) => `\`${target}\``).join(" or ");
    if (facts.force)
      warnings.push(`deleting \`${branch}\` with ${facts.unmerged} commit(s) not in ${targets}`);
    else
      refusals.push(
        `\`${branch}\` has ${facts.unmerged} commit(s) not in ${targets}, and its work isn't there by a merge, a rebase or a squash either: merge it first, or pass --force to delete it`,
      );
  }

  const { mailbox } = facts;
  if (mailbox.exists && !facts.keepHandoff && mailbox.unread.length > 0) {
    const listed = mailbox.unread.map((message) => `${message.id} ${message.about}`);
    if (facts.force)
      warnings.push(
        [`deleting ${mailbox.unread.length} unread message(s):`, ...listed].join("\n    "),
      );
    else
      refusals.push(
        [
          `${mailbox.unread.length} message(s) to \`${facts.track}\` are unread, and removing the track would delete them:`,
          ...listed.map((line) => `  ${line}`),
          facts.worktree === undefined
            ? `the track has no worktree to read them from (\`msg read\` runs only in one): each is a JSON file in ${mailbox.path}, so look at them there, then pass --force to delete them`
            : `read each from the track's worktree (\`bun run --silent mshape msg read <id>\`), or pass --force to delete them`,
        ].join("\n    "),
      );
  }

  if (facts.worktree !== undefined)
    steps.push({ kind: "worktree", path: facts.worktreePath, force: facts.force });
  if (facts.branchExists) steps.push({ kind: "branch", name: branch });
  if (facts.handoffExists) {
    if (facts.keepHandoff) kept.push(`handoff ${facts.handoffPath} (--keep-handoff)`);
    else steps.push({ kind: "handoff", path: facts.handoffPath });
  }
  if (mailbox.exists) {
    if (facts.keepHandoff) kept.push(`mailbox ${mailbox.path} (--keep-handoff)`);
    else
      steps.push({
        kind: "mailbox",
        path: mailbox.path,
        unread: mailbox.unread.length,
        read: mailbox.read,
      });
  }
  return refusals.length > 0
    ? { refusals, warnings: [], steps: [], kept: [], notes }
    : { refusals, warnings, steps, kept, notes };
};

/** One line per track in `track list`. */
export interface TrackRow {
  readonly track: string;
  readonly status: "stub" | "active" | "invalid" | "none";
  /** Beads labelled `track:<track>` that aren't closed; undefined when beads couldn't say. */
  readonly beads: number | undefined;
  /** Commits not in `main`; undefined without a branch. */
  readonly ahead: number | undefined;
  /** Merged, rebased or squashed into a target; undefined without a branch. */
  readonly merged?: boolean | undefined;
  /** Relative to the main checkout; undefined without a worktree. */
  readonly worktree: string | undefined;
  /** Set when the worktree is on another branch than `track/<track>`. */
  readonly worktreeBranch?: string | undefined;
  /** Why the handoff is `invalid`: `parseHandoff`'s problems, printed under the row. */
  readonly problems?: ReadonlyArray<string> | undefined;
}

export const formatTracks = (rows: ReadonlyArray<TrackRow>): string => {
  if (rows.length === 0) return "no tracks: start one with `mshape track new <name>`";
  const table = [
    ["track", "status", "beads", "ahead", "merged", "worktree"],
    ...rows.map((row) => [
      row.track,
      row.status,
      row.beads === undefined ? "-" : String(row.beads),
      row.ahead === undefined ? "-" : String(row.ahead),
      row.merged === undefined ? "-" : row.merged ? "yes" : "no",
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
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd((widths[column] ?? 0) + 2),
      )
      .join("");
  // Each problem names the file through the `.handoffs` link, which every checkout has.
  return [
    line(table[0] ?? []),
    ...rows.flatMap((row, index) => [
      line(table[index + 1] ?? []),
      ...(row.problems ?? []).map((problem) => `  ${HANDOFFS_LINK}/${row.track}.md: ${problem}`),
    ]),
  ].join("\n");
};
