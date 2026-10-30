import { describe, expect, test } from "bun:test";
import { parseWorktrees, planRm, type RmFacts, sharedPathProblems } from "../../src/core/tracks.ts";

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
    branchCheckedOutAt: [],
    handoffPath: "/r/.git/monkeyshape/handoffs/docs.md",
    handoffExists: true,
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
});
