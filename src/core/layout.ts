/**
 * Where a track lives. Every track-aware command and skill derives these names from here, so
 * the CLI, the skills and the template can't disagree. Paths are absolute and POSIX; `repo`
 * is the main checkout's root.
 *
 *   <parent>/<repo>                      main checkout
 *   <parent>/<repo>@<track>              the track's worktree, on branch `track/<track>`
 *   <parent>/<repo>-state/handoffs/      one `<track>.md` per track, outside git
 *   <worktree>/.handoffs                 symlink to the handoffs directory (gitignored)
 *
 * Beads for a track carry the label `track:<track>`.
 */

/** Lowercase words joined by hyphens: `docs`, `init`, `cross-module`. */
export const TRACK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const HANDOFFS_LINK = ".handoffs";

const split = (path: string): { parent: string; name: string } => {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return { parent: trimmed.slice(0, index), name: trimmed.slice(index + 1) };
};

export const trackBranch = (track: string): string => `track/${track}`;

export const trackLabel = (track: string): string => `track:${track}`;

export const worktreePath = (repo: string, track: string): string => {
  const { parent, name } = split(repo);
  return `${parent}/${name}@${track}`;
};

export const stateDir = (repo: string): string => {
  const { parent, name } = split(repo);
  return `${parent}/${name}-state`;
};

export const handoffsDir = (repo: string): string => `${stateDir(repo)}/handoffs`;

export const handoffPath = (repo: string, track: string): string =>
  `${handoffsDir(repo)}/${track}.md`;

/** The track a worktree belongs to, from its directory name, or undefined for the main checkout. */
export const trackOf = (repo: string, worktree: string): string | undefined => {
  const main = split(repo);
  const here = split(worktree);
  if (here.parent !== main.parent || !here.name.startsWith(`${main.name}@`)) return undefined;
  const track = here.name.slice(main.name.length + 1);
  return TRACK_NAME.test(track) ? track : undefined;
};
