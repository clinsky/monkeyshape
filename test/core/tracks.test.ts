import { describe, expect, test } from "bun:test";
import type { Integration } from "../../src/core/model.ts";
import {
  describeStep,
  openBeadsByTrack,
  parseWorktrees,
  planRm,
  type RmFacts,
  sharedPathProblems,
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
