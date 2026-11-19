/**
 * `mshape review <n>` and `mshape review rm <n>`: a pull request's head in a detached worktree
 * beside the tracks, with `tracks.shared-paths` and the handoffs linked in, for the `review-pr`
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
import * as Effect from "effect/Effect";
import { isLgtm, type ReviewInput, reviewMessage } from "../core/handshake.ts";
import {
  HANDOFFS_LINK,
  handoffsStore,
  mainCheckout,
  PR_NUMBER,
  reviewAddress,
  reviewerAddress,
  reviewerTrackOf,
  reviewPath,
  reviewRef,
  reviewsDir,
  reviewTrackPath,
  TRACK_NAME,
  trackBranch,
  trackOf,
} from "../core/layout.ts";
import { formatInbox } from "../core/mail.ts";
import { listedBeads } from "../core/trackPr.ts";
import { sharedPathProblems } from "../core/tracks.ts";
import type { TrackError, WorkspaceError } from "../schemas/errors.ts";
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

/**
 * The track a PR comes from when its head isn't a track's branch (`3lo`): a track's worktree
 * that has the PR's branch checked out, or its head commit; else the one track the beads its
 * body lists are labelled with. Undefined when nothing says, or the evidence disagrees.
 */
const trackOfPr = (repo: string, pr: string, head: string) =>
  Effect.gen(function* () {
    const fields = (yield* jsonOf(repo, [
      "gh",
      "api",
      `repos/{owner}/{repo}/pulls/${pr}`,
      "-q",
      "{ref: .head.ref, body: .body} | @json",
    ])) as { ref?: unknown; body?: unknown } | undefined;
    const ref = typeof fields?.ref === "string" ? fields.ref : undefined;
    for (const worktree of yield* worktrees(repo)) {
      const track = trackOf(repo, worktree.path);
      if (track === undefined || worktree.prunable) continue;
      if (ref !== undefined && worktree.branch === ref) return track;
      if ((yield* git(worktree.path, ["rev-parse", "HEAD"])).stdout.trim() === head) return track;
    }
    const body = typeof fields?.body === "string" ? fields.body : "";
    const labelled = new Set<string>();
    for (const id of listedBeads(body)) {
      const shown = yield* jsonOf(repo, ["bd", "show", id, "--json"]);
      for (const label of JSON.stringify(shown ?? "").match(/track:[a-z0-9-]+/g) ?? [])
        labelled.add(label.slice("track:".length));
    }
    const named = [...labelled].filter((name) => TRACK_NAME.test(name));
    return named.length === 1 ? named[0] : undefined;
  });

/** A command's JSON output, or nothing when it isn't there or fails. */
const jsonOf = (repo: string, command: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ran = yield* Effect.try({
      try: () => Bun.spawnSync([...command], { cwd: repo, stdout: "pipe", stderr: "pipe" }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (ran === undefined || ran.exitCode !== 0) return undefined;
    return yield* Effect.try({
      try: (): unknown => JSON.parse(ran.stdout.toString()),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
  });

/**
 * The move's lines, and a note when it took a session off a track's reviewer address to a
 * PR's own: that track's next message to its reviewer would reach no one there.
 */
const movedOff = (lines: ReadonlyArray<string>, pr: string): ReadonlyArray<string> =>
  lines.flatMap((line) => {
    const from = / (review-[a-z][a-z0-9-]*) -> review-\d+\b/.exec(line)?.[1];
    const track = from === undefined ? undefined : reviewerTrackOf(from);
    return track === undefined
      ? [line]
      : [
          line,
          `note: this session left \`${from}\`: nothing says #${pr} is track ${track}'s (its head isn't \`track/${track}\`, no worktree of ${track} has it, and its beads aren't labelled \`track:${track}\`). If it is, \`mshape review <n>\` on ${track}'s PR moves back`,
        ];
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
 * `tracks.shared-paths` linked into the review's worktree, after a create or a move alike: a path
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
    const track = (yield* trackOfHead(repo, head)) ?? (yield* trackOfPr(repo, pr, head));
    const move = yield* planReviewMove(
      cwd,
      caller,
      track === undefined ? reviewAddress(pr) : reviewerAddress(track),
    );
    // The main checkout's config may be what the PR fixes (`zw9`): review it all the same.
    const notes: Array<string> = [];
    const shared = yield* loadConfig(repo).pipe(
      Effect.map((config) => config.tracks.sharedPaths),
      Effect.catch((error) =>
        Effect.sync((): ReadonlyArray<string> => {
          notes.push(
            `note: the main checkout's config doesn't load (${error.message}), so no shared paths are linked; the review goes on`,
          );
          return [];
        }),
      ),
    );
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
        ...notes,
        ...(before === head
          ? [`${path} is at the head of #${pr}: ${head}`]
          : [`moved ${path} to the head of #${pr}: ${head}`, `previous head: ${before}`]),
        ...linked,
        ...movedOff(yield* move.apply, pr),
        `next: cd ${path}`,
      ].join("\n");
    }

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
    return [
      ...notes,
      created,
      ...linked,
      ...movedOff(yield* move.apply, pr),
      `next: cd ${path}`,
    ].join("\n");
  });

/**
 * Removes the review's worktree and its fetched ref. A PR from no track also loses its
 * address, `review-<n>`, after its unread mail is listed; `review-<track>` stays, so the
 * reviewer keeps its address and mail between the track's PRs.
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
    const removed: Array<string> = [];
    // review-<n> ends with its review; review-<track> is the reviewer's between the track's PRs.
    if (track === undefined) {
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
    if (track !== undefined)
      removed.push(
        `kept ${address}: its reviewer stays there for track ${track}'s next PR (\`mshape review <n>\` for it keeps the address)`,
      );
    else {
      const sessions = yield* removeSessions(cwd, address);
      if (sessions > 0)
        removed.push(`removed ${sessions} registration${sessions === 1 ? "" : "s"} of ${address}`);
    }
    yield* gitOk(repo, ["worktree", "prune"]);
    return removed.length > 0 ? removed.join("\n") : `no review of #${pr} here; nothing removed`;
  });

/** Mails a track; what it says of the delivery. As `track pr`'s `notify`. */
export type ReviewNotify = (
  to: string,
  subject: string,
  body: string,
) => Effect.Effect<string, TrackError | WorkspaceError>;

/**
 * After `review post`: mails the track the review is of (its link, one line per finding),
 * and on LGTM removes the review's worktree, as `review rm` does: the reviewer keeps
 * `review-<track>` and its mail for the track's next PR. A PR from no track mails no one and
 * keeps its worktree, since `review rm` would end its address too: the PR tells its author.
 */
export const reviewHandshake = (
  cwd: string,
  pr: string,
  url: string,
  review: ReviewInput,
  notify: ReviewNotify,
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const { common } = yield* locate(cwd);
    const track = (yield* reviewTracks(common)).get(pr);
    if (track === undefined) {
      yield* say(
        `note: #${pr} is from no track (or \`mshape review ${pr}\` didn't run here), so no track was mailed: its author learns of the review from the PR`,
      );
      return [];
    }
    const message = reviewMessage(pr, url, review, reviewerAddress(track));
    const sent = yield* notify(track, message.subject, message.body).pipe(
      Effect.catchTags({
        TrackError: (error) =>
          Effect.succeed(`note: track ${track} wasn't mailed: ${error.reason}`),
        WorkspaceError: (error) =>
          Effect.succeed(`note: mailing track ${track} failed: ${error.message}`),
      }),
    );
    if (!isLgtm(review)) return [sent];
    const removed = yield* reviewRm(cwd, pr, say);
    return [sent, removed, `next: cd ${mainCheckout(common)}`];
  });
