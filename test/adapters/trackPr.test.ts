import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prSkeleton } from "../../src/core/conventions.ts";
import { REVIEW_MARKER } from "../../src/core/trackPr.ts";
import {
  base,
  bin,
  body,
  CLI,
  gh,
  mshape,
  pr,
  remoteHas,
  repo,
  sh,
  useTrackPrRepo,
  wt,
} from "./trackPrHarness.ts";

useTrackPrRepo();

describe("track pr", () => {
  test("opens the PR: size, a fresh gate in the Gate section, the narrative as written", async () => {
    await writeFile(`${wt()}/body.md`, body("Why this page."));
    const opened = mshape(wt(), "pr", "--title", "A page", "--body-file", "body.md");
    expect(opened.stderr).toContain("1 changed lines: below the batching default");
    expect(opened.stderr).toContain("running the gate, `mshape gate`");
    expect(opened.stderr).toContain(
      "note: `bd` is not on PATH, so the listed beads weren't checked",
    );
    expect(opened.code).toBe(0);
    expect(opened.stdout).toBe("opened https://example.test/pr/7");
    expect(remoteHas()).toBe(true);
    const created = await pr();
    expect(created.title).toBe("A page");
    expect(created.body).toContain("## What changed and why\n\nWhy this page.\n");
    const head = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    expect(created.body).toContain(`$ mshape gate   # at ${head}, run by mshape track pr`);
    expect(created.body).toContain("gate ran");
    expect(created.body).toContain(" 3 pass");
  });

  test("updates the PR: only the Gate is rewritten; a narrative edited on GitHub survives", async () => {
    await writeFile(`${wt()}/body.md`, body("First."));
    mshape(wt(), "pr", "--title", "A page", "--body-file", "body.md");
    // The agent edits the narrative on GitHub, and commits more.
    const edited = await pr();
    edited.body = edited.body.replace("First.", "Edited by hand on GitHub.");
    await writeFile(`${gh}/pr.json`, JSON.stringify(edited));
    await writeFile(`${wt()}/more.md`, "more\n");
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "more");

    const updated = mshape(wt(), "pr");
    expect(updated.code).toBe(0);
    expect(updated.stdout).toBe(
      "updated https://example.test/pr/7: the Gate section is from this run; every other section is as it was",
    );
    const after = await pr();
    expect(after.body).toContain("Edited by hand on GitHub.");
    expect(after.body).toContain(`# at ${sh(wt(), "rev-parse", "HEAD").slice(0, 12)}`);
    expect(after.body.split("## Gate").length).toBe(2);
    expect(after.title).toBe("A page");
  });

  test("refuses, pushing and posting nothing: no title, uncommitted work, a red gate, a missing section", async () => {
    expect(mshape(wt(), "pr").stderr).toContain(
      "no PR is open from `track/docs`: opening one needs --title",
    );
    await writeFile(`${wt()}/body.md`, body("x").replace("## Evidence\n\nRan it.\n\n", ""));
    await writeFile(`${wt()}/page.md`, "edited, not committed\n");
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").stderr).toContain(
      "`track/docs` has uncommitted changes (M page.md)",
    );
    sh(wt(), "checkout", "--", "page.md");
    const missing = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(missing.stderr).toContain("the body isn't ready, so nothing was pushed or posted:");
    expect(missing.stderr).toContain("the PR body lacks `## Evidence`");

    await writeFile(`${wt()}/body.md`, body("x"));
    await writeFile(`${wt()}/red`, "");
    sh(wt(), "add", "red");
    sh(wt(), "commit", "-qm", "red");
    const red = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(red.code).toBe(1);
    expect(red.stderr).toContain("the gate failed (exit 1) on a clean checkout of");
    expect(red.stderr).toContain("so nothing was pushed or posted");
    expect(red.stderr).toContain("gate ran");
    expect(remoteHas()).toBe(false);
    expect(await Bun.file(`${gh}/pr.json`).exists()).toBe(false);
  });

  test("a commit made while the gate runs isn't pushed: the remote gets the gated commit", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    // The probe from #35's review: the gate makes a commit on the track branch, as a second
    // session might.
    const gated = sh(wt(), "rev-parse", "HEAD");
    const opened = mshape.withEnv({ LATE: wt() })(
      wt(),
      "pr",
      "--title",
      "t",
      "--body-file",
      "body.md",
    );
    expect(opened.code).toBe(0);
    const late = sh(wt(), "rev-parse", "HEAD");
    expect(late).not.toBe(gated);
    const pushed = sh(join(base, "remote.git"), "rev-parse", "refs/heads/track/docs");
    expect(pushed).toBe(gated);
    expect((await pr()).body).toContain(`# at ${gated.slice(0, 12)}`);
    expect(opened.stderr).toContain(
      `note: \`track/docs\` moved to ${late.slice(0, 12)} while the gate ran; pushed ${gated.slice(0, 12)}, the commit it gated. Run track pr again to gate and push the rest`,
    );
  });

  test("a push the remote refuses as non-fast-forward says what to do about its branch", async () => {
    // The remote's track/docs has a commit of its own, as an earlier track of the name leaves.
    sh(base, "clone", "-q", join(base, "remote.git"), "other");
    for (const key of ["user.name", "user.email"]) sh(join(base, "other"), "config", key, "x");
    sh(join(base, "other"), "checkout", "-q", "-b", "track/docs");
    sh(join(base, "other"), "commit", "-q", "--allow-empty", "-m", "an earlier track's");
    sh(join(base, "other"), "push", "-q", "origin", "track/docs");
    await writeFile(`${wt()}/body.md`, body("x"));
    const refused = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("`origin`'s `track/docs` has commits this branch lacks");
    expect(refused.stderr).toContain("delete it (`git push origin --delete track/docs`)");
  });

  test("a create that fails says whether a PR is open now, so nothing is posted twice", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    await writeFile(`${gh}/fail`, "");
    const failed = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      "`gh pr create` failed: HTTP 502. No PR is open from the branch.",
    );
  });

  test("--check-body reads a body on stdin: exit 0 when complete, 1 naming what's missing", () => {
    const check = (text: string) => {
      const result = Bun.spawnSync([process.execPath, CLI, "track", "pr", "--check-body"], {
        cwd: repo,
        stdin: Buffer.from(text),
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
    };
    // What track pr posts has a Gate; the agent's body file need not.
    expect(check(body("x")).out).toContain("lacks `## Gate`");
    expect(check(body("x").replace("## Not done", "## Gate\n\nran\n\n## Not done")).code).toBe(0);
    const bad = check(prSkeleton());
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("the PR body lacks `## What changed and why`");
    // Headings only: a template-following Beads section in another form passes, as #33's
    // (a backticked id and a full stop, on one line) failed in re-review of #35. track pr itself still
    // refuses it, in the core planPrBody test, since it can't check such a bead with bd.
    const proseBeads = check(
      body("x")
        .replace("## Not done", "## Gate\n\nran\n\n## Not done")
        .replace("- x-abc.1 the bead", "`x-def.21`."),
    );
    expect(proseBeads.out).toBe("the PR body has every required section\n");
    expect(proseBeads.code).toBe(0);
  });
});

const remoteTip = () => sh(join(base, "remote.git"), "rev-parse", "refs/heads/track/docs");

/**
 * A reviewer of track docs' PR #7, live when Claude Code's record of it exists, ended
 * (registered long ago, no record) otherwise. `reviewing`: at `review-docs` with what
 * `mshape review 7` leaves, the PR's worktree recorded as the track's; `idle`: at
 * `review-docs` between the track's PRs, no worktree for this one; `legacy`: at `review-7`,
 * where a reviewer moved before a track's reviewer had `review-<track>`.
 */
const reviewer = async (live: boolean, at: "reviewing" | "idle" | "legacy" = "reviewing") => {
  const session = "11111111-2222-3333-4444-555555555555";
  const pid = 424242;
  const address = at === "legacy" ? "review-7" : "review-docs";
  if (at === "reviewing") {
    sh(repo, "worktree", "add", "-q", "--detach", join(repo, ".agents", "worktrees", "repo.pr-7"));
    await mkdir(join(repo, ".git", "monkeyshape", "reviews"), { recursive: true });
    await writeFile(join(repo, ".git", "monkeyshape", "reviews", "pr-7.track"), "docs\n");
  }
  const dir = join(repo, ".git", "monkeyshape", "sessions", address);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${session}.json`),
    JSON.stringify({
      session,
      pid,
      registered: live ? new Date().toISOString() : "2026-01-01T00:00:00.000Z",
    }),
  );
  if (live) {
    await mkdir(join(base, "no-claude", "sessions"), { recursive: true });
    await writeFile(
      join(base, "no-claude", "sessions", `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: session,
        procStart: "p",
        peerProtocol: 1,
        messagingSocketPath: join(base, "none.sock"),
      }),
    );
  }
  return session;
};

/** The reviews the fake `gh` lists on the PR. */
const reviews = (list: ReadonlyArray<{ commit_id: string; body: string }>) =>
  writeFile(`${gh}/reviews.json`, JSON.stringify(list));

/** The unread mail at `address`. */
const mail = async (address: string) => {
  const dir = join(repo, ".git", "monkeyshape", "mail", address);
  const files = (await readdir(dir).catch(() => [] as Array<string>)).filter((file) =>
    file.endsWith(".json"),
  );
  return Promise.all(
    files.map(
      async (file) =>
        JSON.parse(await Bun.file(join(dir, file)).text()) as { subject: string; body: string },
    ),
  );
};
const subjects = async (address: string) => (await mail(address)).map((message) => message.subject);

/** Opens the PR (#7), then commits more, as answering a review would. */
const openThenCommit = async () => {
  await writeFile(`${wt()}/body.md`, body("x"));
  expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
  await commitFile("fix.md", "fix\n", "a fix");
};

// The plan's review-in-progress table, row by row.
describe("track pr: the branch tip, and a review in progress", () => {
  test("no reviewer's session here: pushes, noting a reviewer elsewhere can't be seen", async () => {
    await openThenCommit();
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(
      "note: no review of #7 is in progress on this machine; a reviewer on another machine can't be seen from here",
    );
    expect(remoteTip()).toBe(sh(wt(), "rev-parse", "HEAD"));
  });

  test("a live reviewer, no review on the PR's head: refused, naming the session; nothing pushed", async () => {
    await openThenCommit();
    const before = remoteTip();
    const session = await reviewer(true);
    const refused = mshape(wt(), "pr");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `the first review of #7 is in progress (session ${session} at \`review-docs\`)`,
    );
    expect(refused.stderr).not.toContain("running the gate");
    expect(remoteTip()).toBe(before);
  });

  test("a live reviewer, the answer already pushed: a run that moves nothing goes ahead, and --body-only too", async () => {
    // The review was on an earlier head; the author pushed the answer, and the reviewer's
    // session is still live. Re-running track pr on that tip, or refreshing only the body,
    // changes nothing under the reviewer.
    await openThenCommit();
    expect(mshape(wt(), "pr").code).toBe(0);
    await reviewer(true);
    await reviews([{ commit_id: "0".repeat(40), body: "## Fit\n\nround 1" }]);
    const again = mshape(wt(), "pr");
    expect(again.stderr).not.toContain("is in progress");
    expect(again.code).toBe(0);
    await writeFile(`${wt()}/body.md`, body("refreshed"));
    const bodyOnly = mshape(wt(), "pr", "--body-only", "--body-file", "body.md");
    expect(bodyOnly.stderr).not.toContain("is in progress");
    expect(bodyOnly.code).toBe(0);
    expect((await pr()).body).toContain("refreshed");
    // A commit that moves the head answers the posted review too (gyd): pushed.
    await commitFile("more.md", "more\n", "more");
    expect(mshape(wt(), "pr").code).toBe(0);
  });

  test("a thread reply on the head (an empty-bodied review) isn't the reviewer's review (#79's blocker)", async () => {
    await openThenCommit();
    await reviewer(true);
    // No review yet, only the author's replies in threads: the first review is still coming.
    await reviews([
      { commit_id: remoteTip(), body: "" },
      { commit_id: remoteTip(), body: "" },
    ]);
    const before = remoteTip();
    const refused = mshape(wt(), "pr");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the first review of #7 is in progress");
    expect(remoteTip()).toBe(before);
  });

  test("a review answered in two pushes: neither is refused while the reviewer is live, and it is mailed each (gyd)", async () => {
    await openThenCommit();
    await reviewer(true);
    await reviews([{ commit_id: remoteTip(), body: `## Fit\n\nround 1\n\n${REVIEW_MARKER}` }]);
    const first = mshape(wt(), "pr");
    expect(first.code).toBe(0);
    await commitFile("rest.md", "the rest, once another PR merged\n", "the rest of the answer");
    const second = mshape(wt(), "pr");
    expect(second.code).toBe(0);
    const mailed = await subjects("review-docs");
    expect(mailed).toHaveLength(2);
    expect(
      mailed.every((subject) => /^#7 pushed [0-9a-f]{12}: CI not waited for$/.test(subject)),
    ).toBe(true);
  });

  test("a live reviewer whose review is on the PR's head (findings to answer): pushes", async () => {
    await openThenCommit();
    await reviewer(true);
    await reviews([{ commit_id: remoteTip(), body: "## Fit\n\nfindings" }]);
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(remoteTip()).toBe(sh(wt(), "rev-parse", "HEAD"));
  });

  test("a live reviewer at review-<n>, where it moved before review-<track>: still refused", async () => {
    await openThenCommit();
    const before = remoteTip();
    const session = await reviewer(true, "legacy");
    const refused = mshape(wt(), "pr");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `the first review of #7 is in progress (session ${session} at \`review-7\`)`,
    );
    expect(remoteTip()).toBe(before);
  });

  test("a live reviewer at review-<track> between the track's PRs (no worktree for this one): pushes", async () => {
    await openThenCommit();
    await reviewer(true, "idle");
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(remoteTip()).toBe(sh(wt(), "rev-parse", "HEAD"));
  });

  test("the reviewer's session ended without posting: pushes, with a note", async () => {
    await openThenCommit();
    await reviewer(false);
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(
      "note: a reviewer's session at `review-docs` ended without posting a review; pushing",
    );
  });

  test("HEAD on another branch with the next bead's commits: gates and pushes track/<name>'s tip only", async () => {
    await openThenCommit();
    const tip = sh(wt(), "rev-parse", "HEAD");
    sh(wt(), "switch", "-q", "-c", "docs-next");
    await commitFile("next.md", "next bead\n", "the next bead");
    // The next bead breaks the gate: only the track branch's tip is gated.
    await commitFile("red", "", "red on the next branch");
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(
      `note: \`docs-next\` is checked out; track pr gates and pushes \`track/docs\` at ${tip.slice(0, 12)}, and nothing else`,
    );
    expect(remoteTip()).toBe(tip);
    expect((await pr()).body).toContain(`# at ${tip.slice(0, 12)}`);
  });

  test("the gate runs on a clean checkout: a file only the worktree has can't pass it", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    // The gate needs support.txt, which exists in the worktree but was never committed.
    await writeFile(`${wt()}/support.txt`, "here, untracked\n");
    const failed = mshape.withEnv({ NEED: "support.txt" })(
      wt(),
      "pr",
      "--title",
      "t",
      "--body-file",
      "body.md",
    );
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("note: untracked files aren't gated or pushed (support.txt)");
    expect(failed.stderr).toContain("the gate failed (exit 1) on a clean checkout");
    expect(remoteHas()).toBe(false);
    sh(wt(), "add", "support.txt");
    sh(wt(), "commit", "-qm", "support");
    expect(
      mshape.withEnv({ NEED: "support.txt" })(wt(), "pr", "--title", "t", "--body-file", "body.md")
        .code,
    ).toBe(0);
  });

  test("a failing gate names its failing tests and keeps the whole log", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    await commitFile("red", "", "red");
    const failed = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Failing tests (1):\n  suite > the red test\n");
    const log = join(repo, ".git", "monkeyshape", "gate", "docs.log");
    expect(failed.stderr).toContain(`The whole output: ${log}`);
    expect(await Bun.file(log).text()).toContain("gate ran");
    // The scratch checkout is gone either way.
    expect(
      await Bun.file(join(repo, ".agents", "worktrees", "repo.gate-docs", "page.md")).exists(),
    ).toBe(false);
  });
});

const checks = (name: string, runs: ReadonlyArray<object>) =>
  writeFile(`${gh}/${name}`, JSON.stringify(runs));

// The plan's --body-only and behind rows, and --wait.
describe("track pr: --body-only, behind main, --wait", () => {
  test("--body-only with the tip unchanged since the gate: edits the body, no push, no gate", async () => {
    await writeFile(`${wt()}/body.md`, body("First."));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    const gate = (await pr()).body.split("## Gate")[1].split("## ")[0];
    await writeFile(`${wt()}/body.md`, body("Reworded while the PR waits."));
    const edited = mshape(wt(), "pr", "--body-only", "--body-file", "body.md");
    expect(edited.code).toBe(0);
    expect(edited.stderr).not.toContain("running the gate");
    expect(edited.stdout).toContain("the body only, with no push and no gate");
    const after = await pr();
    expect(after.body).toContain("Reworded while the PR waits.");
    expect(after.body.split("## Gate")[1].split("## ")[0]).toBe(gate);
  });

  test("--body-only with the tip moved: refused, since the Gate section would be false", async () => {
    await writeFile(`${wt()}/body.md`, body("First."));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    const pushed = remoteTip();
    await commitFile("more.md", "more\n", "more");
    const refused = mshape(wt(), "pr", "--body-only", "--body-file", "body.md");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--body-only would leave the Gate section false");
    expect(refused.stderr).toContain("Nothing was posted");
    expect(remoteTip()).toBe(pushed);
    expect((await pr()).body).toContain("First.");
  });

  test("--body-only with no PR open: refused", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--body-only", "--body-file", "body.md").stderr).toContain(
      "no PR is open from `track/docs`",
    );
  });

  test("behind main: pushes, warning how far; conflicting: names the files", async () => {
    await writeFile(join(repo, "other.md"), "main's\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "main moves");
    sh(repo, "push", "-q", "origin", "main");
    await writeFile(`${wt()}/body.md`, body("x"));
    const behind = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(behind.code).toBe(0);
    expect(behind.stderr).toContain("warning: the branch is 1 commit behind `origin/main`.");

    await writeFile(join(repo, "page.md"), "main's own page\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "main writes the page too");
    sh(repo, "push", "-q", "origin", "main");
    await commitFile("more.md", "more\n", "more");
    const conflicting = mshape(wt(), "pr");
    expect(conflicting.code).toBe(0);
    expect(conflicting.stderr).toContain(
      "warning: the branch is 2 commits behind `origin/main`, and conflicts with it in page.md.",
    );
  });

  test("--body-only with nothing changed: posts nothing, and --wait reports CI as it stands (#80's review)", async () => {
    await checks("checks-0.json", []);
    await checks("checks.json", [
      { id: 900, name: "check", status: "completed", conclusion: "success" },
    ]);
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md", "--wait").code).toBe(0);
    const calls = await Bun.file(`${gh}/calls.log`).text();
    const same = mshape(wt(), "pr", "--body-only", "--wait");
    expect(same.code).toBe(0);
    expect(same.stdout).toContain("the body and title are as they were, so nothing was posted");
    expect(same.stdout).toContain("CI passed on");
    const added = (await Bun.file(`${gh}/calls.log`).text()).slice(calls.length);
    expect(added).not.toContain("PATCH");
  });

  test("--body-only on a branch that conflicts with main: warns, as a push does (#80's review)", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    await writeFile(join(repo, "page.md"), "main's own page\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "main writes the page too");
    sh(repo, "push", "-q", "origin", "main");
    await writeFile(`${wt()}/body.md`, body("Reworded."));
    const edited = mshape(wt(), "pr", "--body-only", "--body-file", "body.md");
    expect(edited.code).toBe(0);
    expect(edited.stderr).toContain(
      "warning: the branch is 1 commit behind `origin/main`, and conflicts with it in page.md.",
    );
  });

  test("up to date with main: no warning", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").stderr).not.toContain(
      "warning:",
    );
  });

  test("--wait returns CI's outcome: passed, or exit 1 naming the failed check", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    // Before the post, the commit has no runs; after it, checks.json's.
    await checks("checks-0.json", []);
    await checks("checks.json", [
      { id: 101, name: "check", status: "completed", conclusion: "success" },
      { id: 102, name: "body", status: "completed", conclusion: "success" },
    ]);
    const passed = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md", "--wait");
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain(
      `CI passed on ${remoteTip().slice(0, 12)}:\n  body: success\n  check: success`,
    );

    await checks("checks.json", [
      { id: 103, name: "check", status: "completed", conclusion: "failure" },
      { id: 104, name: "body", status: "completed", conclusion: "success" },
    ]);
    // Unchanged, so nothing is posted: --wait reports the runs as they stand.
    await rm(`${gh}/checks-0.json`);
    const failed = mshape(wt(), "pr", "--body-only", "--wait");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("but CI failed on");
    expect(failed.stderr).toContain("check (failure)");
  });

  /** `awaitCi` in a child process, its env pointing at the fake gh: stdout, or the failure. */
  const awaitCiRun = async (
    sha: string,
    timing: object,
    conflicts = false,
    before: ReadonlyArray<number> = [],
    expectCi = false,
    expected: ReadonlyArray<string> = [],
  ) => {
    const script = join(base, "await.ts");
    await writeFile(
      script,
      // By absolute path: the script is in a temp directory, with no node_modules above it.
      `import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};
import { awaitCi } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "adapters", "trackPr.ts"))};
const out = await Effect.runPromise(
  awaitCi(process.cwd(), ${JSON.stringify(sha)}, new Set(${JSON.stringify(before)}), "updated", ${JSON.stringify(timing)}, (line) => Effect.sync(() => console.error(line)), ${conflicts}, undefined, ${expectCi}, ${JSON.stringify(expected)}),
);
console.log(out);
`,
    );
    // --no-install: as CI, where bun never fetches a missing package.
    const result = Bun.spawnSync([process.execPath, "--no-install", script], {
      cwd: wt(),
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_GH: gh },
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      code: result.exitCode,
      stdout: result.stdout.toString().trim(),
      stderr: result.stderr.toString().trim(),
    };
  };

  /** A GitHub Actions expression, written so it isn't read as a JS placeholder. */
  const ACTIONS_EXPR = `$${"{{"} matrix.os }}`;

  test("awaitCi polls until every check has finished", async () => {
    await checks("checks-0.json", []);
    await checks("checks-1.json", [
      { id: 105, name: "check", status: "in_progress", conclusion: null },
    ]);
    await checks("checks-2.json", [
      { id: 106, name: "check", status: "completed", conclusion: "success" },
    ]);
    const ran = await awaitCiRun("a".repeat(40), { pollMs: 5, startMs: 10_000, limitMs: 10_000 });
    expect(ran).toEqual({
      code: 0,
      stdout: "updated\nCI passed on aaaaaaaaaaaa:\n  check: success",
      stderr: "waiting for CI on aaaaaaaaaaaa",
    });
    expect(await Bun.file(`${gh}/polls`).text()).toBe("3");
  });

  test("awaitCi after a body edit: the old runs don't answer it; the rerun does (#80's real run)", async () => {
    const old = { id: 1, name: "body", status: "completed", conclusion: "success" };
    await checks("checks-0.json", [old]);
    await checks("checks-1.json", [
      old,
      { id: 2, name: "body", status: "queued", conclusion: null },
    ]);
    await checks("checks-2.json", [
      old,
      { id: 2, name: "body", status: "completed", conclusion: "failure" },
    ]);
    const ran = await awaitCiRun(
      "d".repeat(40),
      { pollMs: 5, startMs: 10_000, limitMs: 10_000 },
      false,
      [1],
    );
    expect(ran.stderr).toContain("but CI failed on dddddddddddd: body (failure)");
    expect(await Bun.file(`${gh}/polls`).text()).toBe("3");
  });

  test("awaitCi where a workflow runs the gate: a check not started by startMs is queued, so it keeps waiting", async () => {
    // Polls 0 to 4 see nothing (startMs passes meanwhile); then CI starts and passes.
    for (const n of [0, 1, 2, 3, 4]) await checks(`checks-${n}.json`, []);
    await checks("checks-5.json", [
      { id: 107, name: "check", status: "completed", conclusion: "success" },
    ]);
    const ran = await awaitCiRun(
      "e".repeat(40),
      { pollMs: 10, startMs: 20, limitMs: 10_000 },
      false,
      [],
      true,
    );
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("CI passed on eeeeeeeeeeee");
    expect(ran.stderr).toContain("it is likely queued: still waiting");
    expect(ran.stderr).not.toContain("may have no CI");
    // Said once, not on every poll.
    expect(ran.stderr.split("likely queued").length).toBe(2);
  });

  test("awaitCi on a tip CI already ran on, with no rerun coming: once one is overdue, the runs there answer (#99's real run)", async () => {
    const ran = { id: 1, name: "check", status: "completed", conclusion: "success" };
    await checks("checks.json", [ran]);
    const result = await awaitCiRun(
      "f".repeat(40),
      { pollMs: 5, startMs: 20, limitMs: 10_000 },
      false,
      [1],
      true,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("updated\nCI passed on ffffffffffff:\n  check: success");
    expect(result.stderr).not.toContain("may have no CI");
  });

  test("awaitCi doesn't call CI green while the gate's check has no run yet (#105's real run)", async () => {
    const body = { id: 201, name: "body", status: "completed", conclusion: "success" };
    await checks("checks-0.json", [body]);
    await checks("checks-1.json", [body]);
    await checks("checks-2.json", [
      body,
      { id: 202, name: "check", status: "completed", conclusion: "failure" },
    ]);
    const ran = await awaitCiRun(
      "9".repeat(40),
      { pollMs: 5, startMs: 10_000, limitMs: 10_000 },
      false,
      [],
      true,
      ["check"],
    );
    expect(ran.code).toBe(1);
    expect(ran.stderr).toContain("but CI failed on 999999999999: check (failure)");
    expect(await Bun.file(`${gh}/polls`).text()).toBe("3");
  });

  test("awaitCi with a matrix gate whose name is an expression: green once its runs pass (#118's review)", async () => {
    const { gateChecks } = await import("../../src/core/trackPr.ts");
    const expected = gateChecks([
      `on: [pull_request]\njobs:\n  gate:\n    name: gate ${ACTIONS_EXPR}\n    steps:\n      - run: mshape gate\n`,
    ]);
    await checks("checks.json", [
      { id: 301, name: "gate a", status: "completed", conclusion: "success" },
      { id: 302, name: "gate b", status: "completed", conclusion: "success" },
    ]);
    const ran = await awaitCiRun(
      "8".repeat(40),
      { pollMs: 5, startMs: 10_000, limitMs: 10_000 },
      false,
      [],
      true,
      expected,
    );
    expect(ran.code).toBe(0);
    expect(ran.stdout).toContain("CI passed on 888888888888");
  });

  test("awaitCi with no check starting: says so, and stops waiting", async () => {
    const ran = await awaitCiRun("b".repeat(40), { pollMs: 5, startMs: 20, limitMs: 10_000 });
    expect(`${ran.stdout}\n${ran.stderr}`).toContain("note: no CI check started on bbbbbbbbbbbb");
    expect(ran.stdout).not.toContain("conflicts with main");
    expect(ran.code).toBe(0);
    // As #80's real run hit: a PR that conflicts with main gets no CI at all. That is not
    // an outcome to exit 0 on (#80's review).
    const conflicting = await awaitCiRun(
      "c".repeat(40),
      { pollMs: 5, startMs: 20, limitMs: 10_000 },
      true,
    );
    expect(conflicting.code).toBe(1);
    expect(conflicting.stderr).toContain(
      "the branch conflicts with main, and GitHub runs no pull_request workflow on a PR that can't merge. Merge main in",
    );
  });
});

// monkeyshape's own loop: a repo whose CI runs the gate on pull requests.
describe("track pr: the fast stages here, the tests in CI", () => {
  /** Tests that fail here, so running the whole gate fails track pr; CI runs the gate. */
  const withCi = async () => {
    await writeFile(
      `${wt()}/always.test.ts`,
      'import { test, expect } from "bun:test";\ntest("red", () => expect(1).toBe(2));\n',
    );
    await mkdir(`${wt()}/.github/workflows`, { recursive: true });
    await writeFile(
      `${wt()}/.github/workflows/ci.yml`,
      "on:\n  pull_request:\njobs:\n  check:\n    steps:\n      - run: bun run --silent mshape gate\n",
    );
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "a gate CI runs");
  };

  test("with a pull_request workflow running the gate: only its fast phase runs; the Gate section says CI runs the whole gate", async () => {
    await withCi();
    await writeFile(`${wt()}/body.md`, body("x"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain(
      "running the gate's fast phase, `mshape gate --fast`, on a clean checkout of",
    );
    const gate = (await pr()).body.split("## Gate")[1];
    const tip = remoteTip().slice(0, 12);
    expect(gate).toContain(`$ mshape gate --fast   # at ${tip}, run by mshape track pr`);
    expect(gate).toContain("gate ran: gate --fast");
    expect(gate).toContain(`CI: runs the whole gate on ${tip}, not track pr`);
    expect(gate).not.toContain("red");
  });

  test("--wait writes CI's verdict, with each run's link, into the Gate section", async () => {
    await withCi();
    await checks("checks-0.json", []);
    await checks("checks.json", [
      {
        id: 1,
        name: "check",
        status: "completed",
        conclusion: "success",
        html_url: "https://example.test/run/1",
      },
    ]);
    await writeFile(`${wt()}/body.md`, body("x"));
    const waited = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md", "--wait");
    expect(waited.code).toBe(0);
    const gate = (await pr()).body.split("## Gate")[1];
    expect(gate).toContain(
      `CI on ${remoteTip().slice(0, 12)}: check: success ([run](https://example.test/run/1)).`,
    );
    expect(gate).not.toContain("records its result here");
  });

  test("--wait during review: CI recorded as outside review, and the reviewer mailed the head, run and outcome", async () => {
    await withCi();
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    await reviewer(true);
    await reviews([{ commit_id: remoteTip(), body: `## Fit\n\nround 1\n\n${REVIEW_MARKER}` }]);
    await commitFile("fix.md", "the answer\n", "answer the review");
    await checks("checks-0.json", []);
    await checks("checks.json", [
      {
        id: 1,
        name: "check",
        status: "completed",
        conclusion: "success",
        html_url: "https://example.test/run/1",
      },
    ]);
    const waited = mshape(wt(), "pr", "--wait");
    expect(waited.code).toBe(0);
    const head = remoteTip().slice(0, 12);
    expect((await pr()).body.split("## Gate")[1]).toContain(`CI on ${head}: check: success`);
    // At the push, then CI's result (82k: an interrupted wait still sent the first).
    const mailed = await mail("review-docs");
    expect(mailed.map((message) => message.subject).sort()).toEqual([
      `#7 pushed ${head}: CI passed`,
      `#7 pushed ${head}: CI running`,
    ]);
    expect(mailed.find((message) => message.subject.endsWith("CI passed"))?.body).toContain(
      "- check: success https://example.test/run/1",
    );
  });

  test("--wait during review: the reviewer is mailed at the push, before any wait, so no CI or a killed wait loses nothing (#150's run, 82k)", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    await reviews([{ commit_id: remoteTip(), body: `## Fit\n\nround 1\n\n${REVIEW_MARKER}` }]);
    await commitFile("fix.md", "the answer\n", "answer the review");
    await checks("checks.json", []);
    const src = join(import.meta.dir, "..", "..", "src", "adapters");
    const script = join(base, "push.ts");
    await writeFile(
      script,
      `import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};
import { trackPr } from ${JSON.stringify(join(src, "trackPr.ts"))};
import { harnesses } from ${JSON.stringify(join(src, "harnesses", "index.ts"))};
const out = await Effect.runPromise(
  trackPr(process.cwd(), {
    title: undefined, body: undefined, fetchEnv: process.env, configDir: ${JSON.stringify(join(base, "config"))},
    harnesses: harnesses(process.env), wait: { pollMs: 5, startMs: 20, limitMs: 1000 },
    notify: (to, subject) => Effect.sync(() => { console.log("MAIL " + to + ": " + subject); return "sent"; }),
  }, (line) => Effect.sync(() => console.error(line))),
);
console.log(out);
`,
    );
    const ran = Bun.spawnSync([process.execPath, script], {
      cwd: wt(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_GH: gh,
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_PID: "",
        CODEX_THREAD_ID: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = ran.stdout.toString();
    expect(out).toContain(`MAIL review-docs: #7 pushed ${remoteTip().slice(0, 12)}: CI running`);
    expect(out).toContain("note: no CI check started");
  });

  test("--wait killed while CI is queued: the reviewer already has the push (82k)", async () => {
    await withCi();
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    await reviews([{ commit_id: remoteTip(), body: `## Fit\n\nround 1\n\n${REVIEW_MARKER}` }]);
    await commitFile("fix.md", "the answer\n", "answer the review");
    await checks("checks.json", []);
    const child = Bun.spawn([process.execPath, CLI, "track", "pr", "--wait"], {
      cwd: wt(),
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        FAKE_GH: gh,
        CLAUDE_CONFIG_DIR: join(base, "no-claude"),
        XDG_CONFIG_HOME: join(base, "config"),
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_PID: "",
        CODEX_THREAD_ID: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    // Waiting: CI never starts here, and a workflow runs the gate, so it waits minutes. The
    // first poll is the runs before the push; a second means the wait itself has begun.
    const polls = async () =>
      Number(
        (await Bun.file(`${gh}/polls`)
          .text()
          .catch(() => "0")) || 0,
      );
    for (let tries = 0; tries < 300 && (await polls()) < 2; tries++) await Bun.sleep(100);
    expect(await polls()).toBeGreaterThanOrEqual(2);
    child.kill();
    await child.exited;
    expect(
      (await subjects("review-docs")).some((subject) => subject.endsWith(": CI running")),
    ).toBe(true);
  });

  test("track pr watches the PR it opens, and says so once (z1u.17)", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain("Watching pr 7 at docs");
    await commitFile("more.md", "more\n", "more");
    expect(mshape(wt(), "pr").stderr).not.toContain("Watching pr 7");
    const listed = Bun.spawnSync([process.execPath, CLI, "msg", "watch"], {
      cwd: wt(),
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "", CODEX_THREAD_ID: "" },
      stdout: "pipe",
    });
    expect(listed.stdout.toString()).toContain("pr 7");
  });

  test("pushes before any review (gnv): allowed, and no reviewer is mailed", async () => {
    await withCi();
    await openThenCommit();
    expect(mshape(wt(), "pr").code).toBe(0);
    expect(await mail("review-docs")).toEqual([]);
  });

  test("a failing CI is recorded too, and --wait exits 1", async () => {
    await withCi();
    await checks("checks-0.json", []);
    await checks("checks.json", [
      {
        id: 1,
        name: "check",
        status: "completed",
        conclusion: "failure",
        html_url: "https://example.test/run/2",
      },
    ]);
    await writeFile(`${wt()}/body.md`, body("x"));
    const waited = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md", "--wait");
    expect(waited.code).toBe(1);
    expect((await pr()).body).toContain("check: failure ([run](https://example.test/run/2))");
  });

  test("a repo with no `mshape` script runs the gate through mshape's bin in the clean checkout (#89's review)", async () => {
    await withCi();
    await writeFile(`${wt()}/package.json`, JSON.stringify({ scripts: {} }));
    // A stand-in for the installed CLI's bin, as node_modules/.bin holds it.
    await mkdir(`${wt()}/node_modules/.bin`, { recursive: true });
    await writeFile(
      `${wt()}/node_modules/.bin/mshape`,
      'console.log("mshape ran: " + process.argv.slice(2).join(" "));\n',
    );
    sh(wt(), "add", "-f", ".");
    sh(wt(), "commit", "-qm", "an adopter's gate");
    await writeFile(`${wt()}/body.md`, body("x"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.code).toBe(0);
    const gate = (await pr()).body.split("## Gate")[1];
    expect(gate).toContain("mshape ran: gate --fast");
    expect(gate).not.toContain("red");
  });

  test("the main checkout's config doesn't load: track pr still gates and pushes the tip, reading the tip's", async () => {
    // As on #123: the main checkout two commits behind a fix to its config, uncommitted here.
    await writeFile(join(repo, "shape.toml"), 'packs = ["typescript"]\nbogus = 1\n');
    await writeFile(`${wt()}/body.md`, body("x"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.stderr).not.toContain("bogus");
    expect(opened.code).toBe(0);
    expect(remoteHas()).toBe(true);
  });

  test("a gate with no CI workflow stays whole here", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.stderr).toContain("running the gate, `mshape gate`");
    expect((await pr()).body).not.toContain("CI: runs the whole gate");
  });
});

/** The machine's list, under the test's XDG_CONFIG_HOME, and the clone's, inside .git. */
const machineList = async (text: string) => {
  await mkdir(join(base, "config", "monkeyshape"), { recursive: true });
  await writeFile(join(base, "config", "monkeyshape", "denylist"), text);
};
const cloneList = async (text: string) => {
  await mkdir(join(repo, ".git", "monkeyshape"), { recursive: true });
  await writeFile(join(repo, ".git", "monkeyshape", "denylist"), text);
};

const commitFile = async (path: string, text: string, message: string) => {
  await mkdir(join(wt(), path, ".."), { recursive: true });
  await writeFile(join(wt(), path), text);
  sh(wt(), "add", ".");
  sh(wt(), "commit", "-qm", message);
};

// The plan's denylist table, row by row, with invented terms.
describe("track pr: the denylist", () => {
  /** Refused before anything was pushed or posted, saying `where`. */
  const refusedNaming = async (result: ReturnType<typeof mshape>, where: string) => {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "a denylisted term would leave the machine, so nothing was pushed or posted",
    );
    expect(result.stderr).toContain(where);
    expect(result.stderr).not.toContain("running the gate");
    expect(remoteHas()).toBe(false);
    expect(await Bun.file(`${gh}/pr.json`).exists()).toBe(false);
  };

  test("no denylist file anywhere: passes, noting none is configured", async () => {
    await writeFile(`${wt()}/body.md`, body("zorblax"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain("note: no denylist is configured");
    expect(opened.stderr).toContain(join(base, "config", "monkeyshape", "denylist"));
  });

  test("a term in the PR body: refused, naming its line and column", async () => {
    await machineList("# invented\nzorblax\n");
    await writeFile(`${wt()}/body.md`, body("Asked for by zorblax."));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      'the PR body, line 3, column 14: "zorblax"',
    );
  });

  test("a term in the PR title: refused", async () => {
    await machineList("zorblax\n");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "Zorblax support", "--body-file", "body.md"),
      'the PR title, line 1, column 1: "zorblax"',
    );
  });

  test("a term only in a commit message being pushed: refused, naming the commit", async () => {
    await machineList("zorblax\n");
    await commitFile("ok.md", "ok\n", "Fix what zorblax hit");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      `the message of commit ${sha}, line 1, column 10: "zorblax"`,
    );
  });

  test("a term on a line this push adds: refused, naming the file and line", async () => {
    await machineList("zorblax\n");
    await commitFile("notes/a.md", "one\ntwo zorblax\n", "notes");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      `notes/a.md:2:5, added by commit ${sha}: "zorblax"`,
    );
  });

  test("a term in a file path this push adds, an empty file's too: refused, naming the path", async () => {
    await machineList("zorblax\n");
    await commitFile("for-zorblax/empty.md", "", "an empty file");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      "the path for-zorblax/empty.md, added by commit",
    );
  });

  test("paths git C-quotes are read, contents and names both (#73's review)", async () => {
    await machineList("zorblax\n");
    await mkdir(join(wt(), "q"));
    await writeFile(join(wt(), "q", 'notes "v2".md'), "for zorblax\n");
    await writeFile(join(wt(), "q", "a\\b.txt"), "zorblax\n");
    await writeFile(join(wt(), "q", "tab\there.md"), "x zorblax\n");
    await writeFile(join(wt(), "q", 'zorblax".txt'), "");
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "odd names");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    await writeFile(`${wt()}/body.md`, body("x"));
    const refused = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    await refusedNaming(refused, `q/notes "v2".md:1:5, added by commit ${sha}`);
    expect(refused.stderr).toContain(`q/a\\b.txt:1:1, added by commit ${sha}`);
    expect(refused.stderr).toContain(`q/tab\there.md:1:3, added by commit ${sha}`);
    expect(refused.stderr).toContain(`the path q/zorblax".txt, added by commit ${sha}, column 3`);
  });

  test("a file git calls binary (a NUL byte) is scanned as text", async () => {
    await machineList("zorblax\n");
    await commitFile("data.bin", "\u0000\u0001 zorblax\n", "data");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      "data.bin:1:4, added by commit",
    );
  });

  test("a commit only another remote has is still sent, so still scanned (#73's review)", async () => {
    await machineList("zorblax\n");
    await commitFile("wip.md", "zorblax\n", "wip");
    sh(base, "init", "-q", "--bare", "-b", "main", "mirror.git");
    sh(wt(), "remote", "add", "mirror", join(base, "mirror.git"));
    sh(wt(), "push", "-q", "mirror", "HEAD:refs/heads/wip");
    sh(wt(), "fetch", "-q", "mirror");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      "wip.md:1:1, added by commit",
    );
  });

  test("a term differing in case matches", async () => {
    await machineList("ZORBLAX\n");
    await writeFile(`${wt()}/body.md`, body("zorblax"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      'the PR body, line 3, column 1: "ZORBLAX"',
    );
  });

  test("both lists exist: both apply", async () => {
    await machineList("zorblax\n");
    await cloneList("quuxcorp\n");
    await writeFile(`${wt()}/body.md`, body("For Quuxcorp."));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      'the PR body, line 3, column 5: "quuxcorp"',
    );
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "zorblax", "--body-file", "body.md"),
      'the PR title, line 1, column 1: "zorblax"',
    );
  });

  test("a term already on the remote, and the first push's main commits: not scanned", async () => {
    // main's own commit, on the remote, holds the term; so does the branch's pushed commit.
    await writeFile(`${wt()}/body.md`, body("x"));
    await commitFile("old.md", "zorblax, before it was listed\n", "zorblax notes");
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    await machineList("zorblax\n");
    await commitFile("new.md", "clean\n", "more");
    const updated = mshape(wt(), "pr");
    expect(updated.stderr).not.toContain("denylisted");
    expect(updated.code).toBe(0);
  });

  test("the branch merged main since its last push: main's commits aren't scanned, the merge's own changes are", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    // main moves on, with the term in a line and a path, and is pushed.
    await writeFile(join(repo, "zorblax.md"), "zorblax\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "zorblax on main");
    sh(repo, "push", "-q", "origin", "main");
    await machineList("zorblax\n");
    sh(wt(), "merge", "-q", "--no-edit", "main");
    const merged = mshape(wt(), "pr");
    expect(merged.stderr).not.toContain("denylisted");
    expect(merged.code).toBe(0);

    // An evil merge: the merge commit adds a line of its own.
    await writeFile(join(repo, "later.md"), "later\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "later on main");
    sh(repo, "push", "-q", "origin", "main");
    sh(wt(), "merge", "-q", "--no-commit", "main");
    await writeFile(`${wt()}/page.md`, "page\nzorblax in the merge\n");
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "Merge main");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    const evil = mshape(wt(), "pr");
    expect(evil.code).toBe(1);
    expect(evil.stderr).toContain(`page.md:2:1, added by commit ${sha}: "zorblax"`);
    expect(evil.stderr).not.toContain("later.md");
    expect(evil.stderr).not.toContain("zorblax.md");
  });
});

describe("pr.yml", () => {
  test("a born repo's copy checks the same PRs the same way; only how it reaches mshape differs", async () => {
    const root = join(import.meta.dir, "..", "..");
    const here = await Bun.file(join(root, ".github/workflows/pr.yml")).text();
    const born = await Bun.file(join(root, "template/.github/workflows/pr.yml")).text();
    // Up to the job's steps: the trigger, its event types, and the track-only condition.
    const head = (text: string) => text.slice(0, text.indexOf("    steps:"));
    expect(head(born)).toBe(head(here));
    expect(here).toContain("if: startsWith(github.head_ref, 'track/')");
    // The body goes through the environment, never interpolated into the script.
    for (const text of [here, born])
      expect(text).toContain(`BODY: $${"{{"} github.event.pull_request.body }}`);
    // This repo runs mshape from source; a born repo, installed at its pin.
    expect(here).toContain("bun run --silent mshape track pr --check-body");
    expect(born).toContain("| mshape track pr --check-body");
  });
});
