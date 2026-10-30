/**
 * Where a track lives. Every track-aware command and skill derives these names from here, so
 * the CLI, the skills and the template can't disagree. Paths are absolute and POSIX.
 *
 * `common` is git's common directory (`git rev-parse --path-format=absolute
 * --git-common-dir`), the one fact that is the same from the main checkout and from every
 * worktree; `repo`, the main checkout's root, is derived from it, never from the working
 * directory. Everything a human sees stays under the repo's `.agents/`:
 *
 *   <repo>/.agents/skills/                     committed: the shared skills
 *   <repo>/.agents/worktrees/<name>@<track>    gitignored: the track's worktree, on `track/<track>`
 *   <common>/monkeyshape/handoffs/<track>.md   the handoffs themselves, inside git's directory
 *   <repo>/.agents/handoffs                    gitignored symlink to that store
 *   <checkout>/.handoffs                       gitignored symlink to that store, in every checkout
 *
 * The store lives under `.git` because handoffs are live state: `git clean -fdx` deletes
 * ignored files, which would include a handoffs directory in the working tree, but it never
 * touches `.git`. It can delete the symlinks, which the track commands recreate.
 *
 * Beads for a track carry the label `track:<track>`.
 */

/** Lowercase words joined by hyphens: `docs`, `init`, `cross-module`. */
export const TRACK_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const HANDOFFS_LINK = ".handoffs";

/** Committed: the shared skills `mshape skills sync` installs, and the repo's own. */
export const SKILLS_DIR = ".agents/skills";

/** Inside `SKILLS_DIR`: the names of the shared skills sync installed, so a same-named skill
 * of the repo's own is never taken for one, and a retired one can be removed. */
export const SKILLS_MANIFEST = "monkeyshape.json";

/** Committed symlink: Claude Code reads project skills only from here. */
export const CLAUDE_SKILLS_LINK = ".claude/skills";

/** The link's text, relative to `.claude/`, so it resolves in every clone and worktree. */
export const CLAUDE_SKILLS_TARGET = "../.agents/skills";

/** Tracks branch from it, and `track rm` counts a branch as merged once it is contained in it. */
export const MAIN_BRANCH = "main";

const trim = (path: string): string => path.replace(/\/+$/, "");

const repoName = (repo: string): string => trim(repo).slice(trim(repo).lastIndexOf("/") + 1);

export const trackBranch = (track: string): string => `track/${track}`;

export const trackLabel = (track: string): string => `track:${track}`;

export const worktreesDir = (repo: string): string => `${trim(repo)}/.agents/worktrees`;

export const worktreePath = (repo: string, track: string): string =>
  `${worktreesDir(repo)}/${repoName(repo)}@${track}`;

/** The main checkout: the directory holding git's common directory. */
export const mainCheckout = (common: string): string => {
  const path = trim(common);
  return path.slice(0, path.lastIndexOf("/"));
};

/** Where the handoffs are stored: inside git's directory, out of reach of `git clean`. */
export const handoffsStore = (common: string): string => `${trim(common)}/monkeyshape/handoffs`;

/** The user-facing link to the store, in the main checkout. */
export const handoffsLink = (repo: string): string => `${trim(repo)}/.agents/handoffs`;

export const handoffPath = (common: string, track: string): string =>
  `${handoffsStore(common)}/${track}.md`;

/** The track a worktree belongs to, from its path, or undefined for the main checkout. */
export const trackOf = (repo: string, worktree: string): string | undefined => {
  const prefix = `${worktreesDir(repo)}/${repoName(repo)}@`;
  const path = trim(worktree);
  if (!path.startsWith(prefix)) return undefined;
  const track = path.slice(prefix.length);
  return TRACK_NAME.test(track) ? track : undefined;
};
