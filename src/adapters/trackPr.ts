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
import { Clock, Effect } from "effect";
import { GATE_COMMAND, GATE_SCRIPT, parsePrBody, prSizeNote } from "../core/conventions.ts";
import {
  MAIN_BRANCH,
  reviewAddress,
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
  ciState,
  failingTests,
  gateCheckoutPath,
  gatedCommit,
  gateLogPath,
  gateSection,
  gateTail,
  reviewedHead as isReviewed,
  type PostedReview,
  planPrBody,
  type ReviewFacts,
  reviewDecision,
} from "../core/trackPr.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { loadConfig } from "./config.ts";
import { guard, outgoingCommits } from "./denylist.ts";
import { liveSessions } from "./notices.ts";
import { linkHandoffs, linkShared } from "./reviews.ts";
import { fetchUpstream, git, gitOk, locate, mergeTargets, refuse, worktrees } from "./tracks.ts";
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
      "number,url,body",
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
const reviewFacts = (cwd: string, common: string, pr: OpenPr, claudeDir: string, now: Date) =>
  Effect.gen(function* () {
    const address = reviewAddress(String(pr.number));
    const live = yield* liveSessions(cwd, address, claudeDir, now);
    const recorded = yield* Effect.promise(() =>
      readdir(trackSessionsDir(common, address)).catch(() => [] as Array<string>),
    );
    const registered = recorded.some((file) => file.endsWith(".json") && !file.startsWith("."));
    if (live.length === 0 && !registered)
      return { pr: pr.number, live, registered, reviewedHead: false } satisfies ReviewFacts;
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
    return { pr: pr.number, live, registered, reviewedHead } satisfies ReviewFacts;
  });

/** Refuses while a review of `pr` is in progress; otherwise its note, if any. */
const waitOutReview = (
  cwd: string,
  common: string,
  pr: OpenPr | undefined,
  claudeDir: string,
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    if (pr === undefined) return;
    const now = new Date(yield* Clock.currentTimeMillis);
    const decision = reviewDecision(yield* reviewFacts(cwd, common, pr, claudeDir, now));
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
      const shared = (yield* loadConfig(repo)).tracks.sharedPaths;
      for (const line of [
        ...(yield* linkShared(repo, path, "the tip being gated", shared)),
        ...(yield* linkHandoffs(common, repo, path)),
      ])
        if (line.startsWith("note:")) yield* say(line);
      const installed = yield* installDependencies(path);
      if (installed?.startsWith("note:")) yield* say(installed);
      // One stream, as a terminal shows it: the summary lines come from both.
      const gate = yield* spawn(path, [
        "sh",
        "-c",
        `"$0" run ${GATE_SCRIPT} 2>&1`,
        process.execPath,
      ]);
      const log = gateLogPath(common, track);
      yield* Effect.promise(async () => {
        await mkdir(dirname(log), { recursive: true });
        await writeFile(log, gate.stdout);
      });
      return { ...gate, log };
    }).pipe(
      Effect.ensuring(removeCheckout(repo, path).pipe(Effect.orElseSucceed(() => undefined))),
    );
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

/**
 * `--wait`: polls the check runs on `sha` until every one has finished; `done` and CI's
 * outcome, or a failure naming the checks that didn't pass. gh 2.4 has no `pr checks --watch`.
 */
export const awaitCi = (
  cwd: string,
  sha: string,
  done: string,
  timing: CiTiming,
  say: (line: string) => Effect.Effect<void>,
  /** The branch conflicts with its base, so GitHub runs no pull_request workflow on it. */
  conflicts = false,
) =>
  Effect.gen(function* () {
    yield* say(`waiting for CI on ${sha.slice(0, 12)}`);
    const started = yield* Clock.currentTimeMillis;
    for (;;) {
      const listed = yield* spawn(cwd, [
        "gh",
        "api",
        `repos/{owner}/{repo}/commits/${sha}/check-runs`,
        "--paginate",
        "-q",
        ".check_runs[] | {name, status, conclusion} | @json",
      ]);
      if (listed.code !== 0)
        return yield* refuse(
          `${done}; but CI's checks on ${sha.slice(0, 12)} couldn't be read: ${listed.stderr || `exit ${listed.code}`}`,
        );
      const runs = yield* Effect.try({
        try: () =>
          listed.stdout
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as CheckRun),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => [] as Array<CheckRun>));
      const state = ciState(runs);
      const waited = (yield* Clock.currentTimeMillis) - started;
      if (state.kind === "done")
        return state.failed.length === 0
          ? `${done}\nCI passed on ${sha.slice(0, 12)}:\n${state.lines}`
          : yield* refuse(
              `${done}; but CI failed on ${sha.slice(0, 12)}: ${state.failed.join(", ")}\n${state.lines}`,
            );
      if (state.kind === "none" && waited >= timing.startMs)
        return `${done}\nnote: no CI check started on ${sha.slice(0, 12)} within ${Math.round(timing.startMs / 1000)}s, so there is nothing to wait for${
          conflicts
            ? ". The branch conflicts with main, and GitHub runs no pull_request workflow on a PR that can't merge: merge main in, then run track pr --wait again"
            : ""
        }`;
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
    readonly claudeDir: string;
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
    yield* waitOutReview(top, common, existing, options.claudeDir, say);
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
      const url = yield* publish(top, branch, existing, options.title, plan.body);
      const done = `updated ${url}: the body only, with no push and no gate; the Gate section is still the run on ${tip.slice(0, 12)}`;
      return options.wait === undefined ? done : yield* awaitCi(top, tip, done, options.wait, say);
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
    yield* say(
      `running the gate, \`${GATE_COMMAND}\`, on a clean checkout of ${tip.slice(0, 12)}: it can take minutes`,
    );
    const gate = yield* gateOnTip(common, repo, track, tip, say);
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

    const plan = planPrBody(
      options.body ?? existing?.body ?? "",
      gateSection(GATE_COMMAND, tip, gate.stdout),
    );
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
    yield* waitOutReview(top, common, existing, options.claudeDir, () => Effect.void);
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

    const url = yield* publish(top, branch, existing, options.title, plan.body);
    const done = existing
      ? `updated ${url}: the Gate section is from this run; every other section is ${options.body === undefined ? "as it was" : "from --body-file"}`
      : `opened ${url}`;
    return options.wait === undefined
      ? done
      : yield* awaitCi(top, tip, done, options.wait, say, behindMain.conflicts);
  });
