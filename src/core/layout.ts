/**
 * Where a track lives. Every track-aware command and skill derives these names from here, so
 * the CLI, the skills and the template can't disagree. Paths are absolute and POSIX; `repo`
 * is the main checkout's root. Everything stays under the repo's `.agents/`, so nothing
 * clutters the directory around it:
 *
 *   <repo>/.agents/skills/                     committed: the shared skills
 *   <repo>/.agents/worktrees/<name>@<track>    gitignored: the track's worktree, on `track/<track>`
 *   <repo>/.agents/handoffs/<track>.md         gitignored: one handoff per track
 *   <checkout>/.handoffs                       gitignored symlink to the handoffs, in every checkout
 *
 * Beads for a track carry the label `track:<track>`.
 */

/** Lowercase words joined by hyphens: `docs`, `init`, `cross-module`. */
export const TRACK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const HANDOFFS_LINK = ".handoffs";

const trim = (path: string): string => path.replace(/\/+$/, "");

const repoName = (repo: string): string => trim(repo).slice(trim(repo).lastIndexOf("/") + 1);

export const trackBranch = (track: string): string => `track/${track}`;

export const trackLabel = (track: string): string => `track:${track}`;

export const worktreesDir = (repo: string): string => `${trim(repo)}/.agents/worktrees`;

export const worktreePath = (repo: string, track: string): string =>
  `${worktreesDir(repo)}/${repoName(repo)}@${track}`;

export const handoffsDir = (repo: string): string => `${trim(repo)}/.agents/handoffs`;

export const handoffPath = (repo: string, track: string): string =>
  `${handoffsDir(repo)}/${track}.md`;

/** The track a worktree belongs to, from its path, or undefined for the main checkout. */
export const trackOf = (repo: string, worktree: string): string | undefined => {
  const prefix = `${worktreesDir(repo)}/${repoName(repo)}@`;
  const path = trim(worktree);
  if (!path.startsWith(prefix)) return undefined;
  const track = path.slice(prefix.length);
  return TRACK_NAME.test(track) ? track : undefined;
};
