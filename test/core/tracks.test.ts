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
    expect(problems([".handoffs"])[0]).toContain("at or under `.handoffs`");
    expect(problems([".git/hooks"])[0]).toContain("at or under `.git`");
    expect(problems([".github"])).toEqual([]);
  });
});

test("worktree porcelain: branch names short, detached has none", () => {
  const porcelain =
    "worktree /r\nHEAD 1\nbranch refs/heads/main\n\nworktree /r/.agents/worktrees/r@a\nHEAD 2\ndetached\n";
  expect(parseWorktrees(porcelain)).toEqual([
    { path: "/r", branch: "main" },
    { path: "/r/.agents/worktrees/r@a", branch: undefined },
  ]);
});

describe("what track rm may do", () => {
  const facts: RmFacts = {
    track: "docs",
    worktreePath: "/r/.agents/worktrees/r@docs",
    worktree: { path: "/r/.agents/worktrees/r@docs", branch: "track/docs" },
    pathExists: true,
    changes: [],
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
    const plan = planRm({ ...facts, force: true, changes: ["?? x"], branchCheckedOutAt: ["/r"] });
    expect(plan.refusals).toHaveLength(1);
    expect(plan.steps).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });

  test("a rerun after a partial removal plans only what remains", () => {
    const plan = planRm({ ...facts, worktree: undefined, pathExists: false });
    expect(plan.steps.map((step) => step.kind)).toEqual(["branch", "handoff"]);
  });
});
