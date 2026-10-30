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
 * Creates the review's worktree at the pull request's head, or moves an existing one to the
 * current head, printing the previous one: a re-review checks a regression test against both.
 */
export const reviewNew = (cwd: string, pr: string) =>
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
      if (before === head) return `${path} is already at the head of #${pr}: ${head}`;
      yield* gitOk(path, ["checkout", "--quiet", "--detach", head]);
      return [
        `moved ${path} to the head of #${pr}: ${head}`,
        `previous head: ${before}`,
        `next: cd ${path}`,
      ].join("\n");
    }

    const notes: Array<string> = [];
    if (!(yield* ignored(repo, posix.relative(repo, path))))
      notes.push(
        `note: the worktrees directory (\`${posix.relative(repo, path)}\`) is not gitignored; add it to .gitignore`,
      );
    yield* gitOk(repo, ["worktree", "add", "--quiet", "--detach", path, head]);
    const said = [`created ${path} at the head of #${pr}: ${head}`];
    const link = Effect.gen(function* () {
      for (const entry of shared) {
        const target = `${repo}/${entry}`;
        if (!(yield* lexists(target)))
          notes.push(`note: shared path \`${entry}\` is missing in ${repo}; not linked`);
        else if (yield* lexists(`${path}/${entry}`))
          notes.push(
            `note: shared path \`${entry}\` is tracked at the head of #${pr}; not linked. A shared path must be gitignored, never tracked`,
          );
        else {
          yield* linkTo(repo, `${path}/${entry}`, target);
          said.push(`linked ${path}/${entry} -> ${target}`);
        }
      }
    });
    yield* link.pipe(
      Effect.catch((error) =>
        refuse(
          [
            `review ${pr}: stopped: ${error.message}`,
            ...said.map((line) => `done: ${line}`),
            `undo with \`mshape review rm ${pr}\``,
          ].join("\n  "),
        ),
      ),
    );
    return [...notes, ...said, `next: cd ${path}`].join("\n");
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
