/**
 * `mshape track pr` while its PR is in review: the plan's review-in-progress rows, the
 * handshake's push mail, and the reviewer's address. The shared harness is
 * `./trackPrHarness.ts`; the rest of track pr's tests are in trackPr.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REVIEW_MARKER } from "../../src/core/trackPr.ts";
import {
  body,
  commitFile,
  mshape,
  openThenCommit,
  pr,
  remoteHas,
  remoteTip,
  repo,
  reviewer,
  reviews,
  sh,
  subjects,
  useTrackPrRepo,
  wt,
} from "./trackPrHarness.ts";

useTrackPrRepo();

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
