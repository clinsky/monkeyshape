import { describe, expect, test } from "bun:test";
import type { Integration } from "../../src/core/model.ts";
import {
  type BeadsById,
  describeStep,
  hygieneWarnings,
  openAfterMerge,
  openBeadsByTrack,
  ownPrs,
  parseTrackPrs,
  parseWorktrees,
  planRm,
  type RmFacts,
  sharedPathProblems,
  type TrackPr,
  trackDone,
} from "../../src/core/tracks.ts";

describe("shared paths as a whole", () => {
  test("distinct, non-nested paths outside .handoffs and .git pass", () => {
    expect(sharedPathProblems(["data", "cases", "data-large", ".cache/x"])).toEqual([]);
  });

  test("duplicates, nesting either way, and .handoffs or .git are each named", () => {
    const problems = (paths: ReadonlyArray<string>) =>
      sharedPathProblems(paths).map((p) =>
        p.replace("tracks.sharedPaths in shape.config.ts: ", ""),
      );
    expect(problems(["data", "data"])).toContain("`data` is listed twice");
    expect(problems(["data/large", "data"])).toEqual([
      "`data/large` lies under `data`: list only `data`",
    ]);
    expect(problems([".handoffs"])[0]).toContain("overlaps `.handoffs`");
    expect(problems([".git/hooks"])[0]).toContain("overlaps `.git`");
    // The worktrees directory, linked into a worktree, would contain that worktree.
    expect(problems([".agents/worktrees"])[0]).toContain("overlaps `.agents/worktrees`");
    expect(problems([".agents/handoffs"])[0]).toContain("overlaps `.agents/handoffs`");
    expect(problems([".agents"])).toHaveLength(2);
    expect(problems([".agents/cache"])).toEqual([]);
    expect(problems([".github"])).toEqual([]);
  });
});

test("worktree porcelain: branch names short, detached has none", () => {
  const porcelain =
    "worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/.agents/worktrees/r@a\nHEAD 2\ndetached\nprunable gitdir file points to non-existent location\n";
  expect(parseWorktrees(porcelain)).toEqual([
    { path: "/r", branch: "main", prunable: false },
    { path: "/r/.agents/worktrees/r@a", branch: undefined, prunable: true },
  ]);
});

describe("what track rm may do", () => {
  const facts: RmFacts = {
    track: "docs",
    worktreePath: "/r/.agents/worktrees/r@docs",
    worktree: { path: "/r/.agents/worktrees/r@docs", branch: "track/docs", prunable: false },
    pathExists: true,
    changes: [],
    statusError: undefined,
    branchExists: true,
    unmerged: 0,
    merged: true,
    mergeTargets: ["main"],
    branchCheckedOutAt: [],
    handoffPath: "/r/.git/monkeyshape/handoffs/docs.md",
    handoffExists: true,
    beads: { integration: { state: "ok" }, setting: "optional", open: [] },
    mailbox: { path: "/r/.git/monkeyshape/mail/docs", exists: false, unread: [], read: 0 },
    sessions: { live: [] },
    force: false,
    keepHandoff: false,
  };

  test("worktree, then branch, then handoff", () => {
    expect(planRm(facts).steps.map((step) => step.kind)).toEqual(["worktree", "branch", "handoff"]);
  });

  test("a running Claude Code session refuses, naming it; --force goes ahead, saying so", () => {
    const sessions = { live: ["681a4ec1", "9f00ab12"] };
    const refused = planRm({ ...facts, sessions });
    expect(refused.steps).toEqual([]);
    expect(refused.refusals).toEqual([
      "2 Claude Code session(s) still running in `docs` would lose their worktree: 681a4ec1, 9f00ab12. Quit each one (`/exit`), or pass --force",
    ]);
    const forced = planRm({ ...facts, sessions, force: true });
    expect(forced.refusals).toEqual([]);
    expect(forced.warnings).toEqual([
      "removing the track from under 2 running Claude Code session(s): 681a4ec1, 9f00ab12",
    ]);
    expect(forced.steps.map((step) => step.kind)).toEqual(["worktree", "branch", "handoff"]);
  });

  test("sessions that can't be checked refuse, and --force goes ahead, saying so", () => {
    const sessions = { unknown: "can't read ~/.claude/sessions" };
    expect(planRm({ ...facts, sessions }).refusals).toEqual([
      "can't tell whether a Claude Code session is running in `docs` (can't read ~/.claude/sessions): check by hand, then pass --force",
    ]);
    expect(planRm({ ...facts, sessions, force: true }).warnings).toEqual([
      "removing without knowing whether a Claude Code session runs in the track: can't read ~/.claude/sessions",
    ]);
  });

  test("open beads for the next track of the same name: --keep-beads removes the track and keeps them", () => {
    const beads = {
      integration: { state: "ok" } as Integration,
      setting: "optional" as const,
      open: [{ id: "x-9", title: "next milestone's work", status: "open" }],
    };
    const refused = planRm({ ...facts, beads });
    expect(refused.refusals[0]).toContain(
      "If they are for a new track of this same name that you'll start next (a milestone reusing it), pass --keep-beads to leave them labelled for it. --force doesn't override this",
    );
    expect(planRm({ ...facts, beads, force: true }).steps).toEqual([]);
    const merged = {
      number: 3,
      state: "MERGED",
      headRefName: "track/docs",
      body: "",
      createdAt: "2026-11-03T12:00:00Z",
    };
    const kept = planRm({ ...facts, beads, keepBeads: true, ownPrs: [merged] });
    expect(kept.refusals).toEqual([]);
    expect(kept.steps.map((step) => step.kind)).toEqual(["worktree", "branch", "handoff"]);
    expect(kept.kept).toEqual([
      "1 open bead(s) labelled `track:docs`, for the next track of that name (--keep-beads): start it with `mshape track new docs`\n      x-9 (open) next milestone's work",
    ]);
    // Only a done track hands its beads on: merged, no PR of its own open, one merged (6p7).
    const why = (more: Partial<RmFacts>) =>
      planRm({ ...facts, beads, keepBeads: true, ownPrs: [merged], ...more }).refusals;
    expect(why({ ownPrs: [] })).toEqual([
      "--keep-beads hands the beads to a new track of this name only once this one is done, and that isn't shown: no PR from `track/docs` has merged since the track started. Finish it first, or settle it with the human; --force doesn't override this",
    ]);
    expect(why({ ownPrs: [merged, { ...merged, number: 4, state: "OPEN" }] })[0]).toContain(
      "PR #4 from `track/docs` is still open",
    );
    // Merged is judged against main or its upstream, and the refusal says both (#46's nit).
    expect(
      why({ merged: false, unmerged: 2, force: true, mergeTargets: ["main", "origin/main"] })[0],
    ).toContain("`track/docs` has 2 commit(s) not in `main` or `origin/main`");
    // PRs that can't be read: the fix is gh, not finishing a track that may well be done.
    expect(why({ ownPrs: { unknown: "`gh` is not on PATH" } })).toEqual([
      "--keep-beads hands the beads to a new track of this name only once this one is done, and that isn't shown: its PRs couldn't be read (`gh` is not on PATH), so whether it finished can't be told. Get `gh` working (`gh auth status`), then retry; --force doesn't override this",
    ]);
    expect(why({ ownPrs: { unknown: "x" }, merged: false, unmerged: 1, force: true })[0]).toContain(
      "Get `gh` working (`gh auth status`), finish the rest, then retry",
    );
    // A start that can't be placed isn't a gh failure: its fix is recording it (z2m).
    expect(why({ ownPrs: { unplaced: "no-start" } })).toEqual([
      "--keep-beads hands the beads to a new track of this name only once this one is done, and that isn't shown: its start isn't recorded and its branch's reflog no longer reaches its creation (git expires reflog entries), so which PRs are its own can't be told. Record when it started (`git config branch.track/docs.mshape-started <YYYY-MM-DD>`): if unsure, a later date is safe, and an earlier one may count an earlier track's PRs of this name, then retry; --force doesn't override this",
    ]);
    expect(why({ ownPrs: { unplaced: "no-branch" } })[0]).toContain(
      "its branch is gone, so its start, and which PRs are its own, can't be read. Settle it with the human, then retry",
    );
    expect(why({ ownPrs: { unplaced: "no-start" } })[0]).not.toContain("gh");
    // It speaks only to open beads: a failing bd still refuses.
    const failing = {
      ...beads,
      integration: { state: "failed", reason: "locked" } as Integration,
    };
    expect(
      planRm({ ...facts, beads: failing, keepBeads: true, ownPrs: [merged] }).refusals[0],
    ).toContain("bd failed");
  });

  describe("the mailbox", () => {
    const unread = [
      { id: "20261103-134704-e7e3", about: "from review: the format" },
      { id: "20261103-134704-dfff", about: "unreadable: not JSON" },
    ];
    const withMail = (mailbox: Partial<RmFacts["mailbox"]>, more: Partial<RmFacts> = {}) =>
      planRm({ ...facts, ...more, mailbox: { ...facts.mailbox, exists: true, ...mailbox } });

    test("read mail goes last, with the handoff, and says what it held", () => {
      const plan = withMail({ read: 3 });
      expect(plan.refusals).toEqual([]);
      expect(plan.steps.map(describeStep).at(-1)).toBe(
        "mailbox /r/.git/monkeyshape/mail/docs (0 unread, 3 read)",
      );
    });

    test("unread mail refuses, listing each; --force deletes it, saying so", () => {
      const refused = withMail({ unread });
      expect(refused.steps).toEqual([]);
      expect(refused.refusals).toEqual([
        [
          "2 message(s) to `docs` are unread, and removing the track would delete them:",
          "  20261103-134704-e7e3 from review: the format",
          "  20261103-134704-dfff unreadable: not JSON",
          "read each from the track's worktree (`bun run --silent mshape msg read <id>`), or pass --force to delete them",
        ].join("\n    "),
      ]);
      const forced = withMail({ unread, read: 1 }, { force: true });
      expect(forced.refusals).toEqual([]);
      expect(forced.warnings).toEqual([
        [
          "deleting 2 unread message(s):",
          "20261103-134704-e7e3 from review: the format",
          "20261103-134704-dfff unreadable: not JSON",
        ].join("\n    "),
      ]);
      expect(forced.steps.at(-1)).toEqual({
        kind: "mailbox",
        path: "/r/.git/monkeyshape/mail/docs",
        unread: 2,
        read: 1,
      });
    });

    test("--keep-handoff keeps the mailbox too, unread or not, and doesn't refuse", () => {
      const plan = withMail({ unread }, { keepHandoff: true });
      expect(plan.refusals).toEqual([]);
      expect(plan.steps.map((step) => step.kind)).toEqual(["worktree", "branch"]);
      expect(plan.kept).toEqual([
        "handoff /r/.git/monkeyshape/handoffs/docs.md (--keep-handoff)",
        "mailbox /r/.git/monkeyshape/mail/docs (--keep-handoff)",
      ]);
    });

    test("with no worktree to read it from, unread mail's refusal says where it is instead", () => {
      const plan = withMail(
        { unread: unread.slice(0, 1) },
        { worktree: undefined, pathExists: false, branchExists: false, handoffExists: false },
      );
      expect(plan.refusals[0]).toEndWith(
        "the track has no worktree to read them from (`msg read` runs only in one): each is a JSON file in /r/.git/monkeyshape/mail/docs, so look at them there, then pass --force to delete them",
      );
    });

    test("a mailbox left alone is still a track to remove", () => {
      const plan = withMail(
        { read: 1 },
        { worktree: undefined, pathExists: false, branchExists: false, handoffExists: false },
      );
      expect(plan.refusals).toEqual([]);
      expect(plan.steps.map((step) => step.kind)).toEqual(["mailbox"]);
    });
  });

  test("any refusal means no steps, even alongside what --force would allow", () => {
    const plan = planRm({
      ...facts,
      force: true,
      changes: ["?? x"],
      branchCheckedOutAt: [{ path: "/r", branch: "track/docs", prunable: false }],
    });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.steps).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  test("a rerun after a partial removal plans only what remains", () => {
    const plan = planRm({ ...facts, worktree: undefined, pathExists: false });
    expect(plan.steps.map((step) => step.kind)).toEqual(["branch", "handoff"]);
  });

  test("a stale registration elsewhere asks for a prune, not a branch switch", () => {
    const plan = planRm({
      ...facts,
      branchCheckedOutAt: [{ path: "/gone", branch: "track/docs", prunable: true }],
    });
    expect(plan.refusals).toEqual([
      "`track/docs` is still registered as checked out at /gone, which no longer exists: run `git worktree prune`, then retry",
    ]);
  });

  test("--force does not override a git status that could not be read", () => {
    const plan = planRm({ ...facts, force: true, statusError: "index file corrupt" });
    expect(plan.refusals[0]).toContain("can't read the state of /r/.agents/worktrees/r@docs");
    expect(plan.steps).toEqual([]);
  });

  test("open beads refuse, listing each, and --force does not override them", () => {
    const open = [
      { id: "x-1", title: "Write the guide", status: "open" },
      { id: "x-2", title: "Fix the stub", status: "in_progress" },
    ];
    for (const force of [false, true]) {
      const plan = planRm({
        ...facts,
        force,
        beads: { integration: { state: "ok" }, setting: "optional", open },
      });
      expect(plan.steps).toEqual([]);
      expect(plan.refusals[0]).toContain("`track:docs` still labels 2 bead(s) that aren't closed");
      expect(plan.refusals[0]).toContain("x-2 (in_progress) Fix the stub");
      expect(plan.refusals[0]).toContain(
        "bd update <id> --remove-label track:docs --add-label track:<other>",
      );
    }
  });

  test("beads that can't answer: rm refuses wherever the beads can't be seen", () => {
    const plan = (integration: Integration, setting: "optional" | "required", force = false) =>
      planRm({ ...facts, force, beads: { integration, setting, open: [] } });
    const failed: Integration = { state: "failed", reason: "database is locked" };
    const unavailable: Integration = { state: "unavailable", reason: "bd is not on PATH" };
    const absent: Integration = { state: "absent" };

    // bd ran and failed: the beads can't be seen, under any setting, and --force can't help.
    for (const setting of ["optional", "required"] as const)
      for (const force of [false, true]) {
        const refused = plan(failed, setting, force);
        expect(refused.refusals[0]).toContain(
          "bd failed, so the open beads labelled `track:docs` can't be seen: database is locked",
        );
        expect(refused.steps).toEqual([]);
      }
    expect(plan(unavailable, "required").refusals[0]).toContain(
      "requires beads, but bd is not on PATH",
    );
    expect(plan(absent, "required").refusals[0]).toContain("the repo has no .beads/config.yaml");

    // Beads exist but bd can't run: check only notes it, but rm refuses, --force or not.
    for (const force of [false, true]) {
      const refused = plan(unavailable, "optional", force);
      expect(refused.refusals).toEqual([
        "this repo has beads (.beads/), but bd is not on PATH, so the beads labelled `track:docs` can't be seen and removing the track might orphan them: get `bd` working (then `bd list --label track:docs --status open,in_progress,blocked,deferred` shows them), and retry; --force doesn't override this",
      ]);
      expect(refused.steps).toEqual([]);
    }
    const quiet = plan(absent, "optional");
    expect(quiet.notes).toEqual([
      "this repo has no beads (no .beads/), so open beads were not checked",
    ]);
    expect(quiet.steps).toHaveLength(3);
  });
});

test("open beads by track: closed ones and other labels left out, a bead in two tracks counted twice", () => {
  const byTrack = openBeadsByTrack([
    { id: "a", title: "A", status: "open", labels: ["track:docs", "process"] },
    { id: "b", title: "B", status: "closed", labels: ["track:docs"] },
    { id: "c", title: "C", status: "blocked", labels: ["track:docs", "track:init"] },
    { id: "d", title: "D", status: "open", labels: ["track:Not_A_Track"] },
    { id: "e", title: "E", status: "open" },
    "not a row",
  ]);
  expect([...byTrack.keys()].sort()).toEqual(["docs", "init"]);
  expect(byTrack.get("docs")?.map((bead) => bead.id)).toEqual(["a", "c"]);
  expect(byTrack.get("init")).toEqual([{ id: "c", title: "C", status: "blocked" }]);
});

describe("whether a track is done", () => {
  const pr = (
    number: number,
    state: string,
    body = "",
    createdAt = "2026-11-02T10:00:00Z",
  ): TrackPr => ({
    number,
    state,
    headRefName: "track/docs",
    body,
    createdAt,
  });
  const facts = { beads: 0, branchExists: true, merged: true, prs: [pr(1, "MERGED")] };

  test("done only when no open bead, merged (or no branch), no open PR and one merged", () => {
    expect(trackDone(facts)).toBe("yes");
    expect(trackDone({ ...facts, branchExists: false, merged: undefined })).toBe("yes");
    // No PR ever merged: a track that hasn't finished anything, such as one just made.
    expect(trackDone({ ...facts, prs: [] })).toBe("no");
    expect(trackDone({ ...facts, prs: [pr(1, "CLOSED")] })).toBe("no");
    expect(trackDone({ ...facts, beads: 1 })).toBe("no");
    expect(trackDone({ ...facts, merged: false })).toBe("no");
    expect(trackDone({ ...facts, prs: [pr(1, "MERGED"), pr(2, "OPEN")] })).toBe("no");
  });

  test("a track's PRs are its branch's, opened since it started: not an earlier track's of the name", () => {
    const started = new Date("2026-11-03T12:00:00Z");
    const old = pr(16, "MERGED", "", "2026-10-31T09:00:00Z");
    const now = pr(32, "MERGED", "", "2026-11-03T12:30:00Z");
    const other = { ...pr(33, "MERGED", "", "2026-11-03T13:00:00Z"), headRefName: "track/review" };
    expect(ownPrs([old, now, other], "docs", started)?.map((p) => p.number)).toEqual([32]);
    // Only the old one: this track has merged nothing, so it isn't done.
    expect(trackDone({ ...facts, prs: ownPrs([old], "docs", started) })).toBe("no");
    // No start known, or no PRs read: which PRs are this track's can't be said.
    expect(ownPrs([now], "docs", undefined)).toBeUndefined();
    expect(ownPrs(undefined, "docs", started)).toBeUndefined();
  });

  test("a fact that can't be read is unknown, never yes; any no still says no", () => {
    expect(trackDone({ ...facts, beads: undefined })).toBe("unknown");
    expect(trackDone({ ...facts, prs: undefined })).toBe("unknown");
    expect(trackDone({ ...facts, prs: undefined, beads: 2 })).toBe("no");
  });

  test("a bead a merged PR lists but that is still open is flagged; closed, unknown or unmerged ones aren't", () => {
    const task = (status: string, labels: ReadonlyArray<string> = [], type = "task") => ({
      status,
      type,
      labels,
    });
    const beads: BeadsById = new Map([
      ["x-abc.1", task("open")],
      ["x-abc.2", task("closed", ["track:docs"])],
      ["x-abc.3", task("in_progress", ["track:docs"])],
      ["x-abc.4", task("in_progress", ["track:docs", "track:review"])],
      // Another track's: listed here because this track's work fed it (#38 and f4y.26).
      ["x-abc.5", task("in_progress", ["track:review"])],
      // Owned without a track, as the beads check says (#39's last nit): no track's to close.
      ["x-abc.6", task("open", [], "epic")],
      ["x-abc.7", task("open", [], "milestone")],
      ["x-abc.8", task("open", ["milestone"])],
      ["x-abc.9", task("open", ["process"])],
      // Set aside with what is left in its notes, as the warning advises (#39's round 4).
      ["x-abc.10", task("deferred")],
      ["x-abc.11", task("pinned")],
    ]);
    const body = `## Beads\n\n${["x-abc.1 one", "x-abc.2 two", "x-abc.4", "x-abc.5", "x-abc.6", "x-abc.7", "x-abc.8", "x-abc.9", "x-abc.10", "x-abc.11", "x-zzz.9 unknown to bd"].map((item) => `- ${item}`).join("\n")}\n`;
    expect(
      openAfterMerge(
        [pr(5, "MERGED", body), pr(6, "OPEN", "## Beads\n\n- x-abc.3\n")],
        beads,
        "docs",
      ),
    ).toEqual([
      "x-abc.1 (open) is listed in merged PR #5 but still open: close it if its work is done (`bd close x-abc.1`), or write what is left in its notes and defer it (`bd defer x-abc.1`)",
      "x-abc.4 (in_progress) is listed in merged PR #5 but still open: close it if its work is done (`bd close x-abc.4`), or write what is left in its notes and defer it (`bd defer x-abc.4`)",
    ]);
  });

  test("hygiene: a State older than the branch's last commit; a done track still on disk", () => {
    const base = { track: "docs", done: "no" as const, hasWorktree: true };
    expect(hygieneWarnings({ ...base, stateDate: "2026-11-02", lastCommit: "2026-11-03" })).toEqual(
      [
        "its handoff's State (2026-11-02) is older than `track/docs`'s last commit (2026-11-03): rewrite State (`/handoff`)",
      ],
    );
    expect(hygieneWarnings({ ...base, stateDate: "2026-11-03", lastCommit: "2026-11-03" })).toEqual(
      [],
    );
    expect(hygieneWarnings({ ...base, stateDate: undefined, lastCommit: "2026-11-03" })).toEqual(
      [],
    );
    expect(
      hygieneWarnings({ ...base, done: "yes", stateDate: undefined, lastCommit: undefined }),
    ).toEqual(["done: remove it with `mshape track rm docs`"]);
    expect(
      hygieneWarnings({ ...base, done: "unknown", stateDate: undefined, lastCommit: undefined }),
    ).toEqual([]);
  });

  test("gh's JSON is PRs or nothing: a row that isn't a PR makes the whole answer unknown", () => {
    expect(
      parseTrackPrs(
        '[{"number":1,"state":"OPEN","headRefName":"track/a","body":"","createdAt":"2026-11-03T00:00:00Z"}]',
      ),
    ).toHaveLength(1);
    // Without createdAt a PR can't be placed in a track's life.
    expect(
      parseTrackPrs('[{"number":1,"state":"OPEN","headRefName":"track/a","body":""}]'),
    ).toBeUndefined();
    expect(parseTrackPrs('[{"number":1}]')).toBeUndefined();
    expect(parseTrackPrs("not json")).toBeUndefined();
    expect(parseTrackPrs("{}")).toBeUndefined();
  });
});
