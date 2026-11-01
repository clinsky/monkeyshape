import { describe, expect, test } from "bun:test";
import type { Integration } from "../../src/core/model.ts";
import {
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
    mergeTargets: ["main"],
    branchCheckedOutAt: [],
    handoffPath: "/r/.git/monkeyshape/handoffs/docs.md",
    handoffExists: true,
    beads: { integration: { state: "ok" }, setting: "optional", open: [] },
    force: false,
    keepHandoff: false,
  };

  test("worktree, then branch, then handoff", () => {
    expect(planRm(facts).steps.map((step) => step.kind)).toEqual(["worktree", "branch", "handoff"]);
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

  test("beads that can't answer: refusals and notes as `mshape check` decides them", () => {
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

    const noted = plan(unavailable, "optional");
    expect(noted.refusals).toEqual([]);
    expect(noted.notes[0]).toContain("open beads were not checked: bd is not on PATH");
    expect(noted.steps).toHaveLength(3);
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
