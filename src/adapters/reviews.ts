/**
 * `mshape review <n>` and `mshape review rm <n>`: a pull request's head in a detached worktree
 * beside the tracks, with `tracks.sharedPaths` linked in, for the `review-pr` skill. A review is
 * not a track: no branch, no handoff, no label. Its state lives on the pull request, and the
 * worktree is scratch, removed when the review ends. Paths come from `src/core/layout.ts`.
 */
import { posix } from "node:path";
import { Effect } from "effect";
import { PR_NUMBER, reviewPath, reviewRef } from "../core/layout.ts";
import { sharedPathProblems } from "../core/tracks.ts";
import { loadConfig } from "./config.ts";
import { git, gitOk, ignored, lexists, linkTo, locate, refuse, worktrees } from "./tracks.ts";

/** Pull requests are fetched from here, as GitHub publishes them: `refs/pull/<n>/head`. */
const REMOTE = "origin";

const numberProblem = (pr: string) =>
  PR_NUMBER.test(pr)
    ? Effect.void
    : refuse(`give the pull request's number, e.g. \`mshape review 12\` (got '${pr}')`);

/** Fetch the head into the review's own ref; the commit it names. */
const fetchHead = (repo: string, pr: string) =>
  Effect.gen(function* () {
    const ref = reviewRef(pr);
    const fetched = yield* git(repo, [
      "fetch",
      "--quiet",
      "--no-write-fetch-head",
      REMOTE,
      `+refs/pull/${pr}/head:${ref}`,
    ]);
    if (fetched.code !== 0)
      return yield* refuse(
        `could not fetch pull request #${pr} from \`${REMOTE}\` (as \`refs/pull/${pr}/head\`, which GitHub publishes): ${fetched.stderr || `exit ${fetched.code}`}`,
      );
    return yield* gitOk(repo, ["rev-parse", `${ref}^{commit}`]);
  });

/**
 * `tracks.sharedPaths` linked into the review's worktree, after a create or a move alike: a path
 * the head tracks is the PR's own (git put it there) and only noted; a missing link is made.
 */
const linkShared = (repo: string, path: string, pr: string, shared: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const said: Array<string> = [];
    for (const entry of shared) {
      const target = `${repo}/${entry}`;
      if ((yield* git(path, ["cat-file", "-e", `HEAD:${entry}`])).code === 0)
        said.push(
          `note: shared path \`${entry}\` is tracked at the head of #${pr}; not linked. A shared path must be gitignored, never tracked`,
        );
      else if (yield* lexists(`${path}/${entry}`)) continue;
      else if (!(yield* lexists(target)))
        said.push(`note: shared path \`${entry}\` is missing in ${repo}; not linked`);
      else {
        yield* linkTo(repo, `${path}/${entry}`, target);
        said.push(`linked ${path}/${entry} -> ${target}`);
      }
    }
    return said;
  });

/**
 * Puts an existing review worktree exactly at `head`. It is scratch, so edits to tracked files
 * are discarded, after `say` lists them; untracked probes stay, unless `head` tracks the same
 * path. Never git's "commit or stash" advice: the stash is shared by every worktree.
 */
const resetTo = (path: string, head: string, say: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const status = yield* git(path, ["status", "--porcelain", "--untracked-files=all"]);
    for (const line of status.stdout.split("\n").filter((line) => line.trim() !== "")) {
      const file = line.slice(3);
      if (!line.startsWith("??")) yield* say(`discarding in ${path}: ${line.trim()}`);
      else if ((yield* git(path, ["cat-file", "-e", `${head}:${file}`])).code === 0)
        yield* say(`overwriting in ${path}: ${file}, which the head tracks`);
    }
    yield* gitOk(path, ["checkout", "--quiet", "--force", "--detach", head]);
  });

/**
 * Creates the review's worktree at the pull request's head, or puts an existing one there,
 * printing the previous head: a re-review checks a regression test against both.
 */
export const reviewNew = (cwd: string, pr: string, say: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* numberProblem(pr);
    const { repo } = yield* locate(cwd);
    const shared = (yield* loadConfig(repo)).tracks.sharedPaths;
    const problems = sharedPathProblems(shared);
    if (problems.length > 0) return yield* refuse(problems.join("\n"));
    const path = reviewPath(repo, pr);
    const registered = (yield* worktrees(repo)).some((worktree) => worktree.path === path);
    const present = yield* lexists(path);
    if (registered && !present)
      return yield* refuse(
        `git still has a worktree registered at ${path}: run \`git worktree prune\`, then this again`,
      );
    if (!registered && present)
      return yield* refuse(
        `${path} exists but git has no worktree there: remove it, then this again`,
      );

    const head = yield* fetchHead(repo, pr);
    if (registered) {
      const before = yield* gitOk(path, ["rev-parse", "HEAD"]);
      yield* resetTo(path, head, say);
      const linked = yield* linkShared(repo, path, pr, shared);
      return [
        ...(before === head
          ? [`${path} is at the head of #${pr}: ${head}`]
          : [`moved ${path} to the head of #${pr}: ${head}`, `previous head: ${before}`]),
        ...linked,
        `next: cd ${path}`,
      ].join("\n");
    }

    const notes: Array<string> = [];
    if (!(yield* ignored(repo, posix.relative(repo, path))))
      notes.push(
        `note: the worktrees directory (\`${posix.relative(repo, path)}\`) is not gitignored; add it to .gitignore`,
      );
    yield* gitOk(repo, ["worktree", "add", "--quiet", "--detach", path, head]);
    const created = `created ${path} at the head of #${pr}: ${head}`;
    const linked = yield* linkShared(repo, path, pr, shared).pipe(
      Effect.catch((error) =>
        refuse(
          [
            `review ${pr}: stopped: ${error.message}`,
            `done: ${created}`,
            `undo with \`mshape review rm ${pr}\``,
          ].join("\n  "),
        ),
      ),
    );
    return [...notes, created, ...linked, `next: cd ${path}`].join("\n");
  });

/**
 * Removes the review's worktree and its fetched ref. Everything in a review worktree is scratch,
 * so changes in it are discarded, after `say` lists them. Shared data is only ever linked, and
 * removing the worktree removes the links, never their targets.
 */
export const reviewRm = (cwd: string, pr: string, say: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* numberProblem(pr);
    const { repo } = yield* locate(cwd);
    const path = reviewPath(repo, pr);
    const registered = (yield* worktrees(repo)).some((worktree) => worktree.path === path);
    const present = yield* lexists(path);
    if (!registered && present)
      return yield* refuse(
        `${path} exists but git has no worktree there, so it isn't a review's: left alone`,
      );
    const removed: Array<string> = [];
    if (registered && present) {
      const status = yield* gitOk(path, ["status", "--porcelain", "--untracked-files=all"]);
      const changes = status.split("\n").filter((line) => line.trim() !== "");
      yield* Effect.forEach(changes, (line) => say(`discarding in ${path}: ${line.trim()}`));
      yield* gitOk(repo, ["worktree", "remove", "--force", path]);
      removed.push(`removed ${path}`);
    }
    const ref = reviewRef(pr);
    if ((yield* git(repo, ["show-ref", "--verify", "--quiet", ref])).code === 0) {
      yield* gitOk(repo, ["update-ref", "-d", ref]);
      removed.push(`removed ${ref}`);
    }
    yield* gitOk(repo, ["worktree", "prune"]);
    return removed.length > 0 ? removed.join("\n") : `no review of #${pr} here; nothing removed`;
  });
