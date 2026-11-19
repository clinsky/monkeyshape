/**
 * `mshape track pr`: run the gate fresh, push `track/<name>`, and open or update its PR. The
 * Gate section is the only one it writes, from the run it just did; the rest of the body is
 * the agent's (`--body-file`, or the PR as it stands). It gates and pushes the tip of
 * `track/<name>`, whatever the worktree has checked out, on a clean checkout of that tip.
 * Nothing is pushed or posted while a review of the PR is in progress, nor unless the track
 * branch has no uncommitted changes, nothing it would send holds a denylisted term, the gate
 * passes and the body has every required section, so a failure leaves the PR as it was. The
 * decisions are in `src/core/trackPr.ts`.
 */
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { GATE_COMMAND, parsePrBody, prSizeNote, setPrSections } from "../core/conventions.ts";
import {
  MAIN_BRANCH,
  reviewAddress,
  reviewerAddress,
  reviewPath,
  trackBranch,
  trackOf,
  trackSessionsDir,
  worktreePath,
} from "../core/layout.ts";
import {
  behindWarning,
  bodyOnlyProblem,
  type CheckRun,
  changedLines,
  ciLine,
  ciState,
  failingTests,
  gateCheckoutPath,
  gateChecks,
  gatedCommit,
  gateLogPath,
  gatePlan,
  gatePlanCommand,
  gateSection,
  gateTail,
  reviewedHead as isReviewed,
  type PostedReview,
  planPrBody,
  type ReviewFacts,
  reviewDecision,
  withCiLine,
} from "../core/trackPr.ts";
import { type TrackError, WorkspaceError } from "../schemas/errors.ts";
import { loadConfig } from "./config.ts";
import { guard, outgoingCommits } from "./denylist.ts";
import type { Harnesses } from "./harnesses/index.ts";
import { liveSessions } from "./notices.ts";
import { bunPath } from "./process.ts";
import { linkHandoffs, linkShared } from "./reviews.ts";
import {
  fetchUpstream,
  git,
  gitOk,
  locate,
  mergeTargets,
  refuse,
  reviewTracks,
  worktrees,
} from "./tracks.ts";
import { installDependencies } from "./workspace.ts";

/** A command's exit and output; `missing` when it isn't on PATH. */
const spawn = (
  cwd: string,
  command: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
) =>
  Effect.try({
    try: () => {
      const child = Bun.spawnSync([...command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(env === undefined ? {} : { env }),
      });
      return {
        missing: false,
        code: child.exitCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString().trim(),
      };
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      /ENOENT|not found in \$PATH/.test(String(cause))
        ? Effect.succeed({ missing: true, code: -1, stdout: "", stderr: "" })
        : Effect.fail(
            new WorkspaceError({
              operation: "run",
              path: command.join(" "),
              reason: String(cause),
            }),
          ),
    ),
  );

interface OpenPr {
  readonly number: number;
  readonly url: string;
  readonly body: string;
  readonly title: string;
}

/** The open PR from `branch`, if any; a `gh` that can't answer refuses, saying why. */
const openPr = (cwd: string, branch: string) =>
  Effect.gen(function* () {
    const listed = yield* spawn(cwd, [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,body,title",
    ]);
    if (listed.missing)
      return yield* refuse(
        "`gh` is not on PATH, so no PR can be opened: install the GitHub CLI and run `gh auth login`",
      );
    if (listed.code !== 0)
      return yield* refuse(`\`gh pr list\` failed: ${listed.stderr || `exit ${listed.code}`}`);
    const prs = JSON.parse(listed.stdout || "[]") as ReadonlyArray<OpenPr>;
    return prs[0];
  });

/**
 * The track whose worktree `cwd` is in, whatever branch it has checked out: the next bead's
 * local branch is endorsed there while the PR is in review, and `track pr` reads the track
 * branch itself. Refuses outside a registered track worktree.
 */
const trackOfWorktree = (cwd: string) =>
  Effect.gen(function* () {
    const { common, repo } = yield* locate(cwd);
    const top = yield* gitOk(cwd, ["rev-parse", "--show-toplevel"]);
    const here = yield* real(top);
    for (const worktree of yield* worktrees(repo)) {
      if ((yield* real(worktree.path)) !== here) continue;
      const track = trackOf(repo, worktree.path);
      if (track !== undefined) return { track, top, common, repo, head: worktree.branch };
    }
    return yield* refuse(
      `${top} is not a track worktree: tracks live at ${worktreePath(repo, "<track>")}, and track pr runs from one`,
    );
  });

const real = (path: string) => Effect.promise(() => realpath(path).catch(() => path));

/** Whether a review of `pr` is in progress on this machine, by `reviewDecision`. */
const reviewFacts = (
  cwd: string,
  common: string,
  repo: string,
  track: string,
  pr: OpenPr,
  tip: string,
  harnesses: Harnesses,
  now: Date,
) =>
  Effect.gen(function* () {
    const number = String(pr.number);
    // review-<track> is held across the track's PRs, so a reviewer there is on this PR only
    // while `mshape review <n>` has this PR's worktree, recorded as the track's. review-<n>,
    // for a reviewer that moved before addresses were per track, always counts.
    const reviewing =
      (yield* reviewTracks(common)).get(number) === track &&
      (yield* worktrees(repo)).some((worktree) => worktree.path === reviewPath(repo, number));
    const addresses = [...(reviewing ? [reviewerAddress(track)] : []), reviewAddress(number)];
    const live: Array<string> = [];
    let registered = false;
    let address = addresses[0] ?? reviewAddress(number);
    for (const at of addresses) {
      const here = yield* liveSessions(cwd, at, harnesses, now);
      if (here.length > 0 && live.length === 0) address = at;
      live.push(...here);
      const recorded = yield* Effect.promise(() =>
        readdir(trackSessionsDir(common, at)).catch(() => [] as Array<string>),
      );
      registered ||= recorded.some((file) => file.endsWith(".json") && !file.startsWith("."));
    }
    if (live.length === 0 && !registered)
      return {
        pr: pr.number,
        address,
        live,
        registered,
        reviewedHead: false,
        moves: true,
      } satisfies ReviewFacts;
    // REST, not `pr list --json headRefOid`, which gh 2.4 doesn't know.
    const head = yield* spawn(cwd, [
      "gh",
      "api",
      `repos/{owner}/{repo}/pulls/${pr.number}`,
      "-q",
      ".head.sha",
    ]);
    const reviews = yield* spawn(cwd, [
      "gh",
      "api",
      `repos/{owner}/{repo}/pulls/${pr.number}/reviews`,
      "--paginate",
      "-q",
      ".[] | {commit_id, body} | @json",
    ]);
    const unreadable = [head, reviews].find((ran) => ran.code !== 0);
    const posted =
      unreadable === undefined && head.stdout.trim() !== ""
        ? yield* Effect.try({
            try: () =>
              reviews.stdout
                .split("\n")
                .filter((line) => line.trim() !== "")
                .map((line) => JSON.parse(line) as PostedReview),
            catch: () => undefined,
          }).pipe(Effect.orElseSucceed(() => undefined))
        : undefined;
    if (posted === undefined)
      return yield* refuse(
        `a session is registered at \`${address}\`, and the PR's head and reviews couldn't be read to tell whether its review is posted (${unreadable?.stderr || "no head, or reviews that aren't JSON"}), so nothing was pushed or posted`,
      );
    const reviewedHead = isReviewed(posted, head.stdout.trim());
    const moves = head.stdout.trim() !== tip;
    return { pr: pr.number, address, live, registered, reviewedHead, moves } satisfies ReviewFacts;
  });

/** Refuses while a review of `pr` is in progress; otherwise its note, if any. */
const waitOutReview = (
  cwd: string,
  common: string,
  repo: string,
  track: string,
  pr: OpenPr | undefined,
  tip: string,
  harnesses: Harnesses,
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    if (pr === undefined) return;
    const now = new Date(yield* Clock.currentTimeMillis);
    const decision = reviewDecision(
      yield* reviewFacts(cwd, common, repo, track, pr, tip, harnesses, now),
    );
    if ("refuse" in decision) return yield* refuse(decision.refuse);
    if (decision.note !== undefined) yield* say(decision.note);
  });

/**
 * Runs the gate on a fresh detached checkout of `tip`, its dependencies installed and the
 * shared paths linked as in a track's worktree, then removes the checkout. The whole output
 * is kept at `gateLogPath`.
 */
const gateOnTip = (
  common: string,
  repo: string,
  track: string,
  tip: string,
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const path = gateCheckoutPath(repo, track);
    yield* removeCheckout(repo, path);
    yield* gitOk(repo, ["worktree", "add", "--quiet", "--detach", path, tip]);
    return yield* Effect.gen(function* () {
      // The tip's own config, not the main checkout's, which may be behind main or broken.
      // One that doesn't load links nothing here: the gate itself says why it doesn't load.
      const shared = yield* loadConfig(path).pipe(
        Effect.map((config) => config.tracks.sharedPaths),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );
      for (const line of [
        ...(yield* linkShared(repo, path, "the tip being gated", shared)),
        ...(yield* linkHandoffs(common, repo, path)),
      ])
        if (line.startsWith("note:")) yield* say(line);
      const installed = yield* installDependencies(path);
      if (installed?.startsWith("note:")) yield* say(installed);
      const { plan, mshape, checks } = yield* planFor(path);
      yield* say(
        plan.kind === "full"
          ? `running the gate, \`${GATE_COMMAND}\`, on a clean checkout of ${tip.slice(0, 12)}: it can take minutes`
          : `running the gate's fast phase, \`${gatePlanCommand(plan)}\`, on a clean checkout of ${tip.slice(0, 12)}; CI runs the whole gate`,
      );
      // One stream, as a terminal shows it: the summary lines come from both. `$0` is Bun
      // (\`bunPath\`), which a hook's PATH may lack; without one, \`bun\` fails, saying so.
      const args = plan.kind === "fast" ? "gate --fast" : "gate";
      const bun = bunPath() ?? "bun";
      const gate = yield* spawn(path, ["sh", "-c", `${mshape} ${args} 2>&1`, bun]);
      const log = gateLogPath(common, track);
      yield* Effect.promise(async () => {
        await mkdir(dirname(log), { recursive: true });
        await writeFile(log, gate.stdout);
      });
      return { ...gate, log, plan, checks };
    }).pipe(
      Effect.ensuring(removeCheckout(repo, path).pipe(Effect.orElseSucceed(() => undefined))),
    );
  });

/**
 * The gate plan for a checkout, from the workflows that might run the gate, and how to run
 * mshape there: the `mshape` package script (`D-run-mshape`), else its bin, else the PATH's.
 */
const planFor = (path: string) =>
  Effect.promise(async () => {
    const manifest = await Bun.file(`${path}/package.json`)
      .json()
      .catch(() => ({}));
    const script = (manifest as { scripts?: Record<string, unknown> }).scripts?.["mshape"];
    const mshape =
      typeof script === "string"
        ? `"$0" run --silent mshape`
        : (await Bun.file(`${path}/node_modules/.bin/mshape`).exists())
          ? `"$0" ./node_modules/.bin/mshape`
          : "mshape";
    const dir = `${path}/.github/workflows`;
    const files = await readdir(dir).catch(() => [] as Array<string>);
    const workflows: Array<string> = [];
    for (const file of files.filter((name) => /\.ya?ml$/.test(name)))
      workflows.push(
        await Bun.file(`${dir}/${file}`)
          .text()
          .catch(() => ""),
      );
    return { plan: gatePlan(workflows), mshape, checks: gateChecks(workflows) };
  });

/** Removes a scratch checkout, registered or left behind by a crash. */
const removeCheckout = (repo: string, path: string) =>
  Effect.gen(function* () {
    yield* git(repo, ["worktree", "remove", "--force", path]);
    yield* Effect.promise(() => rm(path, { recursive: true, force: true }));
    yield* git(repo, ["worktree", "prune"]);
  });

/** How often to poll CI, and how long to wait for it to start and to finish. */
export interface CiTiming {
  readonly pollMs: number;
  readonly startMs: number;
  readonly limitMs: number;
}

export const CI_TIMING: CiTiming = { pollMs: 15_000, startMs: 180_000, limitMs: 3_600_000 };

/** Fails naming the beads `bd` doesn't know; a missing `bd` is a note. */
const checkBeads = (
  repo: string,
  beads: ReadonlyArray<string>,
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const unknown: Array<string> = [];
    for (const id of beads) {
      const shown = yield* spawn(repo, ["bd", "show", id, "--json"]);
      if (shown.missing) {
        yield* say("note: `bd` is not on PATH, so the listed beads weren't checked");
        break;
      }
      if (shown.code !== 0) unknown.push(id);
    }
    if (unknown.length > 0)
      return yield* refuse(
        `the Beads section lists ${unknown.map((id) => `\`${id}\``).join(", ")}, which bd doesn't know: fix the id, or file the bead first. Nothing was pushed or posted`,
      );
  });

/** The warning when `tip` is behind `target`, naming the files a merge would conflict in. */
const behind = (repo: string, tip: string, target: string) =>
  Effect.gen(function* () {
    const count = yield* git(repo, ["rev-list", "--count", `${tip}..${target}`]);
    const commits = Number(count.stdout.trim());
    if (count.code !== 0 || !Number.isInteger(commits) || commits === 0)
      return { warning: undefined, conflicts: false };
    // Exit 1 lists the conflicted files after the tree; anything else, git couldn't say.
    const merged = yield* git(repo, [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      tip,
      target,
    ]);
    const conflicts =
      merged.code === 0
        ? []
        : merged.code === 1
          ? merged.stdout
              .split("\n")
              .slice(1)
              .filter((line) => line.trim() !== "")
          : undefined;
    return {
      warning: behindWarning({
        target: target.replace(/^refs\/(?:remotes|heads)\//, ""),
        behind: commits,
        conflicts,
      }),
      conflicts: conflicts !== undefined && conflicts.length > 0,
    };
  });

/**
 * Opens the PR or updates its body (and title); the PR's URL. A failure says whether a PR is
 * open now, since gh sometimes fails after GitHub acted, so nothing is posted twice.
 */
const publish = (
  top: string,
  branch: string,
  existing: OpenPr | undefined,
  title: string | undefined,
  body: string,
) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-pr-")));
    const file = join(dir, "body.md");
    yield* Effect.promise(() => writeFile(file, body));
    // An update goes through REST: `gh pr edit` fails on some gh versions, since GitHub
    // retired the Projects (classic) field it asks for.
    const posted = existing
      ? yield* spawn(top, [
          "gh",
          "api",
          "--method",
          "PATCH",
          `repos/{owner}/{repo}/pulls/${existing.number}`,
          "-F",
          `body=@${file}`,
          ...(title === undefined ? [] : ["-f", `title=${title}`]),
        ])
      : yield* spawn(top, [
          "gh",
          "pr",
          "create",
          "--base",
          MAIN_BRANCH,
          "--head",
          branch,
          "--title",
          title ?? "",
          "--body-file",
          file,
        ]);
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
    if (posted.code !== 0) {
      const now = yield* openPr(top, branch).pipe(Effect.orElseSucceed(() => undefined));
      return yield* refuse(
        `${existing ? `updating PR #${existing.number}` : "`gh pr create`"} failed: ${posted.stderr || `exit ${posted.code}`}. ${
          now === undefined
            ? "No PR is open from the branch."
            : `A PR is open now (${now.url}): look at it before running track pr again.`
        }`,
      );
    }
    return existing?.url ?? posted.stdout.trim().split("\n").at(-1) ?? "";
  });

/** With --wait, the ids of the runs already on `tip`, so only CI's answer to this post counts. */
const runsBefore = (cwd: string, tip: string, wait: CiTiming | undefined) =>
  wait === undefined
    ? Effect.succeed(new Set<number>())
    : Effect.map(
        checkRuns(cwd, tip, "nothing was posted"),
        (runs) => new Set(runs.map((run) => run.id)),
      );

/** The check runs on `sha`; `done` says what was already posted, if they can't be read. */
export const checkRuns = (cwd: string, sha: string, done: string) =>
  Effect.gen(function* () {
    const listed = yield* spawn(cwd, [
      "gh",
      "api",
      `repos/{owner}/{repo}/commits/${sha}/check-runs`,
      "--paginate",
      "-q",
      ".check_runs[] | {id, name, status, conclusion, html_url} | @json",
    ]);
    if (listed.code !== 0)
      return yield* refuse(
        `${done}; but CI's checks on ${sha.slice(0, 12)} couldn't be read: ${listed.stderr || `exit ${listed.code}`}`,
      );
    return yield* Effect.try({
      try: () =>
        listed.stdout
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line) as CheckRun),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => [] as Array<CheckRun>));
  });

/**
 * After `--wait`: CI's verdict in the Gate section's CI line, replacing the pending one, so
 * the section is CI's result for the pushed commit. A Gate section with no CI line (the full
 * gate ran here) is left alone.
 */
const recordCiResult =
  (top: string, branch: string, body: string, gate: string) => (runs: ReadonlyArray<CheckRun>) =>
    Effect.gen(function* () {
      const commit = /# at ([0-9a-f]+), run by mshape track pr/.exec(gate)?.[1] ?? "";
      const updated = withCiLine(gate, ciLine(commit, runs));
      if (updated === undefined) return;
      const pr = yield* openPr(top, branch);
      if (pr === undefined) return;
      yield* publish(top, branch, pr, undefined, setPrSections(body, { Gate: updated }));
    });

/**
 * `--wait`: polls the check runs on `sha` until every one has finished; `done` and CI's
 * outcome, or a failure naming the checks that didn't pass. gh 2.4 has no `pr checks --watch`.
 */
export const awaitCi = (
  cwd: string,
  sha: string,
  /** The runs on `sha` before this post: CI's answer to it is a run not among them. */
  before: ReadonlySet<number>,
  done: string,
  timing: CiTiming,
  say: (line: string) => Effect.Effect<void>,
  /** The branch conflicts with its base, so GitHub runs no pull_request workflow on it. */
  conflicts = false,
  /** Writes CI's verdict where it belongs, once every check has finished. */
  onDone: (
    runs: ReadonlyArray<CheckRun>,
  ) => Effect.Effect<void, TrackError | WorkspaceError> = () => Effect.void,
  /**
   * A workflow is known to run the gate on this PR: a check that hasn't started is queued, so
   * the wait for it to start runs to the overall limit, not `startMs`.
   */
  expectCi = false,
  /** The checks CI's gate makes (`gateChecks`): each must have a run before CI is done. */
  expected: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    yield* say(`waiting for CI on ${sha.slice(0, 12)}`);
    const started = yield* Clock.currentTimeMillis;
    let queuedSaid = false;
    for (;;) {
      const runs = yield* checkRuns(cwd, sha, done);
      const waited = (yield* Clock.currentTimeMillis) - started;
      // A tip CI already ran on gets no new run for a push, and none for a body edit no
      // workflow watches: once a new run is overdue, CI's answer is the runs already there.
      const standing = before.size > 0 && waited >= timing.startMs;
      const state = ciState(runs, standing ? new Set() : before, expected);
      if (state.kind === "done") yield* onDone(state.runs);
      if (state.kind === "done")
        return state.failed.length === 0
          ? `${done}\nCI passed on ${sha.slice(0, 12)}:\n${state.lines}`
          : yield* refuse(
              `${done}; but CI failed on ${sha.slice(0, 12)}: ${state.failed.join(", ")}\n${state.lines}`,
            );
      if (state.kind === "none" && waited >= timing.startMs && expectCi && !conflicts) {
        if (!queuedSaid)
          yield* say(
            `note: no CI check has started on ${sha.slice(0, 12)} after ${Math.round(timing.startMs / 1000)}s; a workflow runs the gate on pull requests, so it is likely queued: still waiting, up to ${Math.round(timing.limitMs / 1000)}s in all`,
          );
        queuedSaid = true;
      } else if (state.kind === "none" && waited >= timing.startMs)
        // A conflicting PR is untested and can't merge: not an outcome to exit 0 on.
        return conflicts
          ? yield* refuse(
              `${done}; but no CI check started on ${sha.slice(0, 12)} within ${Math.round(timing.startMs / 1000)}s: the branch conflicts with main, and GitHub runs no pull_request workflow on a PR that can't merge. Merge main in, then run track pr --wait again`,
            )
          : `${done}\nnote: no CI check started on ${sha.slice(0, 12)} within ${Math.round(timing.startMs / 1000)}s, so there is nothing to wait for (this repo may have no CI)`;
      if (waited >= timing.limitMs)
        return yield* refuse(
          `${done}; but CI hadn't finished on ${sha.slice(0, 12)} after ${Math.round(timing.limitMs / 1000)}s (still running: ${state.kind === "running" ? state.pending.join(", ") : "none listed"})`,
        );
      yield* Effect.sleep(timing.pollMs);
    }
  });

export const trackPr = (
  cwd: string,
  options: {
    readonly title: string | undefined;
    /** The agent's whole body: the narrative and evidence, which this keeps as written. */
    readonly body: string | undefined;
    /** The environment for git's network calls: one where it can't prompt. */
    readonly fetchEnv: Readonly<Record<string, string | undefined>>;
    /** The machine's config directory, which holds its denylist. */
    readonly configDir: string;
    /** Claude Code's config directory, where it records the sessions a review runs in. */
    readonly harnesses: Harnesses;
    /** Edit the body only: no push and no gate, refused unless the Gate section still holds. */
    readonly bodyOnly?: boolean;
    /** Wait for CI on the pushed commit after posting, and fail when it fails. */
    readonly wait?: CiTiming;
  },
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const { track, top, common, repo, head } = yield* trackOfWorktree(cwd);
    const branch = trackBranch(track);
    const tipOf = gitOk(repo, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]);
    const tip = yield* tipOf;
    if (head === branch) {
      const status = (yield* gitOk(top, ["status", "--porcelain"]))
        .split("\n")
        .filter((line) => line !== "");
      const changed = status.filter((line) => !line.startsWith("??"));
      if (changed.length > 0)
        return yield* refuse(
          `\`${branch}\` has uncommitted changes (${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", ..." : ""}), and track pr gates and pushes only its commits: commit or discard them, then run track pr again`,
        );
      const untracked = status.filter((line) => line.startsWith("??"));
      if (untracked.length > 0)
        yield* say(
          `note: untracked files aren't gated or pushed (${untracked
            .slice(0, 5)
            .map((line) => line.slice(3))
            .join(", ")}${untracked.length > 5 ? ", ..." : ""})`,
        );
    } else
      yield* say(
        `note: ${head === undefined ? "a detached HEAD" : `\`${head}\``} is checked out; track pr gates and pushes \`${branch}\` at ${tip.slice(0, 12)}, and nothing else`,
      );

    // Before the slow gate, so a missing title or gh, or a review in progress, is said at once.
    const existing = yield* openPr(top, branch);
    if (existing === undefined && (options.title === undefined || options.body === undefined))
      return yield* refuse(
        `no PR is open from \`${branch}\`: opening one needs --title "<title>" and --body-file <path>, a body with every section of .github/pull_request_template.md; track pr fills the Gate section itself`,
      );
    // --body-only pushes nothing, so a review in progress can't be changed under it.
    if (!options.bodyOnly)
      yield* waitOutReview(top, common, repo, track, existing, tip, options.harnesses, say);
    if (options.bodyOnly) {
      if (existing === undefined)
        return yield* refuse(
          `--body-only edits an open PR's body, and no PR is open from \`${branch}\`: open one with --title and --body-file`,
        );
      const head = yield* spawn(top, [
        "gh",
        "api",
        `repos/{owner}/{repo}/pulls/${existing.number}`,
        "-q",
        ".head.sha",
      ]);
      if (head.code !== 0 || head.stdout.trim() === "")
        return yield* refuse(
          `--body-only needs the PR's head to tell whether its Gate section still holds, and \`gh api\` couldn't say (${head.stderr || `exit ${head.code}`}). Nothing was posted`,
        );
      const problem = bodyOnlyProblem({
        tip,
        head: head.stdout.trim(),
        gated: gatedCommit(existing.body),
      });
      if (problem !== undefined) return yield* refuse(`${problem}. Nothing was posted`);
      const kept =
        parsePrBody(existing.body).find((section) => section.name === "Gate")?.text ?? "";
      const plan = planPrBody(options.body ?? existing.body, kept);
      if ("problems" in plan)
        return yield* refuse(
          ["the body isn't ready, so nothing was posted:", ...plan.problems].join("\n  "),
        );
      const note = yield* guard(
        top,
        options.configDir,
        {
          commits: [],
          texts: [
            ...(options.title === undefined ? [] : [{ name: "the PR title", text: options.title }]),
            { name: "the PR body", text: plan.body },
          ],
        },
        "nothing was posted",
      );
      if (note !== undefined) yield* say(note);
      yield* checkBeads(repo, plan.beads, say);
      // As a push does: a conflict means GitHub runs no CI, which --wait must say.
      const unfetchedBody = yield* fetchUpstream(repo, options.fetchEnv);
      if (unfetchedBody !== undefined) yield* say(`note: ${unfetchedBody}`);
      const bodyTargets = yield* mergeTargets(repo);
      const bodyBehind = yield* behind(
        repo,
        tip,
        bodyTargets[bodyTargets.length - 1] ?? MAIN_BRANCH,
      );
      if (bodyBehind.warning !== undefined) yield* say(bodyBehind.warning);
      // Unchanged: GitHub would run nothing new, so post nothing and report CI as it stands.
      const unchanged =
        plan.body === existing.body &&
        (options.title === undefined || options.title === existing.title);
      const before = unchanged ? new Set<number>() : yield* runsBefore(top, tip, options.wait);
      const done = unchanged
        ? `${existing.url}: the body and title are as they were, so nothing was posted`
        : `updated ${yield* publish(top, branch, existing, options.title, plan.body)}: the body only, with no push and no gate; the Gate section is still the run on ${tip.slice(0, 12)}`;
      if (options.wait === undefined) return done;
      return yield* awaitCi(
        top,
        tip,
        before,
        done,
        options.wait,
        say,
        bodyBehind.conflicts,
        recordCiResult(top, branch, plan.body, kept),
        false,
        (yield* planFor(top)).checks,
      );
    }

    const unfetched = yield* fetchUpstream(repo, options.fetchEnv);
    if (unfetched !== undefined) yield* say(`note: ${unfetched}`);
    const targets = yield* mergeTargets(repo);
    const base = yield* gitOk(repo, [
      "merge-base",
      tip,
      targets[targets.length - 1] ?? MAIN_BRANCH,
    ]);
    const lines = changedLines(yield* gitOk(repo, ["diff", "--shortstat", base, tip]));
    yield* say(prSizeNote(lines));
    const behindMain = yield* behind(repo, tip, targets[targets.length - 1] ?? MAIN_BRANCH);
    if (behindMain.warning !== undefined) yield* say(behindMain.warning);

    // Before the slow gate, and after the fetch, so the remote refs say what is published.
    const remote =
      (yield* git(repo, ["config", `branch.${MAIN_BRANCH}.remote`])).stdout.trim() || "origin";
    const unpublished = yield* outgoingCommits(repo, tip, remote);
    const notConfigured = yield* guard(
      top,
      options.configDir,
      {
        commits: unpublished,
        texts: [
          ...(options.title === undefined ? [] : [{ name: "the PR title", text: options.title }]),
          { name: "the PR body", text: options.body ?? existing?.body ?? "" },
        ],
      },
      "nothing was pushed or posted",
    );
    if (notConfigured !== undefined) yield* say(notConfigured);
    const gate = yield* gateOnTip(common, repo, track, tip, say);
    const ranCommand = gatePlanCommand(gate.plan);
    if (gate.code !== 0) {
      const failed = failingTests(gate.stdout);
      return yield* refuse(
        [
          `the gate failed (exit ${gate.code}) on a clean checkout of ${tip.slice(0, 12)}, so nothing was pushed or posted.`,
          ...(failed.length > 0
            ? [
                `Failing tests (${failed.length}):`,
                ...failed.slice(0, 20).map((name) => `  ${name}`),
              ]
            : []),
          "Its last lines:",
          gateTail(gate.stdout),
          `The whole output: ${gate.log}`,
        ].join("\n"),
      );
    }

    const gateText = gateSection(
      ranCommand,
      tip,
      gate.stdout,
      gate.plan.kind === "fast" ? ciLine(tip) : undefined,
    );
    const plan = planPrBody(options.body ?? existing?.body ?? "", gateText);
    if ("problems" in plan)
      return yield* refuse(
        ["the body isn't ready, so nothing was pushed or posted:", ...plan.problems].join("\n  "),
      );
    // The Gate section is new text too: the gate's output could print anything.
    yield* guard(
      top,
      options.configDir,
      { commits: [], texts: [{ name: "the PR body", text: plan.body }] },
      "nothing was pushed or posted",
    );
    yield* checkBeads(repo, plan.beads, say);

    // Again: a review can start while the gate runs.
    yield* waitOutReview(
      top,
      common,
      repo,
      track,
      existing,
      tip,
      options.harnesses,
      () => Effect.void,
    );
    // The commit the gate ran on, not the branch: one made while the gate ran is ungated.
    const pushed = yield* git(repo, ["push", "--quiet", remote, `${tip}:refs/heads/${branch}`], {
      env: { ...options.fetchEnv },
    });
    if (pushed.code !== 0)
      return yield* refuse(
        `\`git push ${remote} ${branch}\` failed, so the PR wasn't touched: ${pushed.stderr || `exit ${pushed.code}`}${
          /non-fast-forward|fetch first|\[rejected\]/.test(pushed.stderr)
            ? `. \`${remote}\`'s \`${branch}\` has commits this branch lacks: if they are an earlier track's of this name (squash-merged, or dropped), delete it (\`git push ${remote} --delete ${branch}\`); if they are this track's, merge them in (\`git pull ${remote} ${branch}\`)`
            : ""
        }`,
      );

    const now = yield* tipOf;
    if (now !== tip)
      yield* say(
        `note: \`${branch}\` moved to ${now.slice(0, 12)} while the gate ran; pushed ${tip.slice(0, 12)}, the commit it gated. Run track pr again to gate and push the rest`,
      );

    const before = yield* runsBefore(top, tip, options.wait);
    const url = yield* publish(top, branch, existing, options.title, plan.body);
    const done = existing
      ? `updated ${url}: the Gate section is from this run; every other section is ${options.body === undefined ? "as it was" : "from --body-file"}`
      : `opened ${url}`;
    if (options.wait === undefined) return done;
    const recordCi = recordCiResult(top, branch, plan.body, gateText);
    return yield* awaitCi(
      top,
      tip,
      before,
      done,
      options.wait,
      say,
      behindMain.conflicts,
      recordCi,
      gate.plan.kind === "fast",
      gate.checks,
    );
  });
