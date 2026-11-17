/**
 * `mshape review <n>` and `mshape review rm <n>`: a pull request's head in a detached worktree
 * beside the tracks, with `tracks.sharedPaths` and the handoffs linked in, for the `review-pr`
 * skill, which reads the charter of the track a PR comes from. A review is not a track: no
 * branch, no handoff of its own, no label. Its state lives on the pull request, and the
 * worktree is scratch, removed when the review ends. It is an address: `review-<track>` for a
 * PR whose head is a track's branch, held across that track's PRs, else `review-<n>`. A
 * session at `main` (or at another review) that runs `mshape review <n>` moves there, so the
 * reviewer's mail is the review's, never the main checkout's or the track's. Paths come from
 * `src/core/layout.ts`.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { posix } from "node:path";
import { Effect } from "effect";
import {
  HANDOFFS_LINK,
  handoffsStore,
  PR_NUMBER,
  reviewAddress,
  reviewerAddress,
  reviewPath,
  reviewRef,
  reviewsDir,
  reviewTrackPath,
  TRACK_NAME,
  trackBranch,
} from "../core/layout.ts";
import { formatInbox } from "../core/mail.ts";
import { sharedPathProblems } from "../core/tracks.ts";
import { loadConfig } from "./config.ts";
import { addressInbox } from "./mail.ts";
import { type Caller, planReviewMove, removeSessions } from "./notices.ts";
import {
  git,
  gitOk,
  ignored,
  lexists,
  linkTo,
  locate,
  refuse,
  reviewTracks,
  worktrees,
} from "./tracks.ts";

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
 * The track whose branch on the remote is at `head`: `track/<name>`, the PR's head branch
 * when the track pushed it with `track pr`. Undefined when none is, or more than one.
 */
const trackOfHead = (repo: string, head: string) =>
  Effect.gen(function* () {
    const listed = yield* git(repo, ["ls-remote", REMOTE, `${trackBranch("*")}`]);
    if (listed.code !== 0) return undefined;
    const tracks = listed.stdout.split("\n").flatMap((line) => {
      const [sha, ref] = line.split("\t");
      const name = ref?.startsWith("refs/heads/track/")
        ? ref.slice("refs/heads/track/".length)
        : "";
      return sha === head && TRACK_NAME.test(name) ? [name] : [];
    });
    return tracks.length === 1 ? tracks[0] : undefined;
  });

/** Records the track a review's PR comes from, for its address after a restart; none clears it. */
const recordTrack = (common: string, pr: string, track: string | undefined) =>
  Effect.promise(async () => {
    const path = reviewTrackPath(common, pr);
    if (track === undefined) await rm(path, { force: true });
    else {
      await mkdir(reviewsDir(common), { recursive: true });
      await writeFile(path, `${track}\n`);
    }
  });

/**
 * `tracks.sharedPaths` linked into the review's worktree, after a create or a move alike: a path
 * the head tracks is the PR's own (git put it there) and only noted; a missing link is made.
 */
export const linkShared = (
  repo: string,
  path: string,
  /** What the checkout holds, for its notes: `the head of #12`. */
  what: string,
  shared: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const said: Array<string> = [];
    for (const entry of shared) {
      const target = `${repo}/${entry}`;
      if ((yield* git(path, ["cat-file", "-e", `HEAD:${entry}`])).code === 0)
        said.push(
          `note: shared path \`${entry}\` is tracked at ${what}; not linked. A shared path must be gitignored, never tracked`,
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
 * The handoffs linked in as `.handoffs`, as in every checkout, so a review reads the charter of
 * the track the PR comes from. A repo with no handoffs store yet has none to read.
 */
export const linkHandoffs = (common: string, repo: string, path: string) =>
  Effect.gen(function* () {
    const link = `${path}/${HANDOFFS_LINK}`;
    const store = handoffsStore(common);
    if ((yield* lexists(link)) || !(yield* lexists(store))) return [];
    yield* linkTo(repo, link, store);
    return [`linked ${link} -> ${store}`];
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
 * printing the previous head: a re-review checks a regression test against both. Then moves
 * the calling session to the reviewer's address (`review-<track>`, else `review-<n>`) when it
 * was at `main` or another review.
 */
export const reviewNew = (
  cwd: string,
  pr: string,
  say: (line: string) => Effect.Effect<void>,
  caller: Caller,
) =>
  Effect.gen(function* () {
    yield* numberProblem(pr);
    const { common, repo } = yield* locate(cwd);
    // The head first: the address depends on the track it is the tip of. Fetching only
    // writes the review's own ref, so a refusal below still leaves nothing changed.
    const head = yield* fetchHead(repo, pr);
    const track = yield* trackOfHead(repo, head);
    const move = yield* planReviewMove(
      cwd,
      caller,
      track === undefined ? reviewAddress(pr) : reviewerAddress(track),
    );
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

    yield* recordTrack(common, pr, track);
    if (registered) {
      const before = yield* gitOk(path, ["rev-parse", "HEAD"]);
      yield* resetTo(path, head, say);
      const linked = [
        ...(yield* linkShared(repo, path, `the head of #${pr}`, shared)),
        ...(yield* linkHandoffs(common, repo, path)),
      ];
      return [
        ...(before === head
          ? [`${path} is at the head of #${pr}: ${head}`]
          : [`moved ${path} to the head of #${pr}: ${head}`, `previous head: ${before}`]),
        ...linked,
        ...(yield* move.apply),
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
    const linked = yield* Effect.map(
      Effect.zip(
        linkShared(repo, path, `the head of #${pr}`, shared),
        linkHandoffs(common, repo, path),
      ),
      ([sharedLinks, handoffLinks]) => [...sharedLinks, ...handoffLinks],
    ).pipe(
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
    return [...notes, created, ...linked, ...(yield* move.apply), `next: cd ${path}`].join("\n");
  });

/**
 * Removes the review's worktree, its fetched ref and, unless another PR of the same track is
 * still under review, the registrations at the reviewer's address.
 * Everything in a review worktree is scratch, so changes in it are discarded, after `say` lists
 * them, and so is the review's unread mail, which stays in its mailbox. Shared data is only
 * ever linked, and removing the worktree removes the links, never their targets.
 */
export const reviewRm = (cwd: string, pr: string, say: (line: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* numberProblem(pr);
    const { common, repo } = yield* locate(cwd);
    const path = reviewPath(repo, pr);
    const all = yield* worktrees(repo);
    const registered = all.some((worktree) => worktree.path === path);
    const present = yield* lexists(path);
    if (!registered && present)
      return yield* refuse(
        `${path} exists but git has no worktree there, so it isn't a review's: left alone`,
      );
    const tracks = yield* reviewTracks(common);
    const track = tracks.get(pr);
    const address = track === undefined ? reviewAddress(pr) : reviewerAddress(track);
    // review-<track> is held across the track's PRs: kept while another of them is reviewed.
    const others = all.flatMap((worktree) => {
      const other = worktree.path.startsWith(reviewPath(repo, ""))
        ? worktree.path.slice(reviewPath(repo, "").length)
        : "";
      return other !== pr && track !== undefined && tracks.get(other) === track ? [other] : [];
    });
    const removed: Array<string> = [];
    if (others.length === 0) {
      const inbox = yield* addressInbox(cwd, address);
      const unread = formatInbox(address, inbox.messages, inbox.unreadable, true);
      if (unread !== "") yield* say(`${unread}\n(left in ${address}'s mailbox)`);
    }
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
    yield* recordTrack(common, pr, undefined);
    if (others.length > 0)
      removed.push(
        `kept ${address}: track ${track}'s ${others.map((other) => `#${other}`).join(", ")} ${others.length === 1 ? "is" : "are"} still under review`,
      );
    else {
      const sessions = yield* removeSessions(cwd, address);
      if (sessions > 0)
        removed.push(`removed ${sessions} registration${sessions === 1 ? "" : "s"} of ${address}`);
    }
    yield* gitOk(repo, ["worktree", "prune"]);
    return removed.length > 0 ? removed.join("\n") : `no review of #${pr} here; nothing removed`;
  });
