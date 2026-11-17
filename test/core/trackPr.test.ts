import { describe, expect, test } from "bun:test";
import { prSkeleton } from "../../src/core/conventions.ts";
import {
  behindWarning,
  bodyOnlyProblem,
  changedLines,
  ciLine,
  ciState,
  GATE_TAIL_LINES,
  gatedCommit,
  gatePlan,
  gatePlanCommand,
  gateSection,
  listedBeads,
  planPrBody,
  REVIEW_MARKER,
  reviewedHead,
  withCiLine,
} from "../../src/core/trackPr.ts";

const filled = prSkeleton({
  "What changed and why": "A hand-written narrative.\n\n    indented code stays",
  Evidence: "Ran it on the real handoffs.",
  Gate: "stale output",
  "Not done": "Nothing.",
  Beads: "- `x-abc.1` the first\n- x-abc.2: the second\n\nAnd prose naming x-zzz, not a list item.",
});

describe("track pr's body", () => {
  test("changed lines are insertions plus deletions, from git's shortstat", () => {
    expect(changedLines(" 13 files changed, 675 insertions(+), 143 deletions(-)")).toBe(818);
    expect(changedLines(" 1 file changed, 1 insertion(+)")).toBe(1);
    expect(changedLines(" 2 files changed, 4 deletions(-)")).toBe(4);
    expect(changedLines("")).toBe(0);
  });

  test("the Gate section is the command, the commit and the output's tail, in a fence it can't close", () => {
    const output = [...Array.from({ length: 30 }, (_, i) => `line ${i}`), "```", " 431 pass"].join(
      "\n",
    );
    const section = gateSection("bun run check", "ecdce38aaaaabbbbccc", `${output}\n\n`);
    const lines = section.split("\n");
    expect(lines[0]).toBe("````");
    expect(lines.at(-1)).toBe("````");
    expect(lines[1]).toBe("$ bun run check   # at ecdce38aaaaa, run by mshape track pr");
    expect(lines.slice(2, -1)).toHaveLength(GATE_TAIL_LINES);
    expect(lines.at(-2)).toBe(" 431 pass");
    expect(section).not.toContain("line 0\n");
    // As biome printed it into #35's first Gate section.
    const coloured =
      "\u001b[0m\u001b[34mChecked 101 files in 58\u001b[0m\u001b[0m\u001b[2m\u001b[34mms\u001b[0m";
    expect(gateSection("c", "abc", coloured).split("\n")[2]).toBe("Checked 101 files in 58ms");
  });

  test("beads are the ids that start list items, backticks and trailing punctuation stripped", () => {
    expect(listedBeads(filled)).toEqual(["x-abc.1", "x-abc.2"]);
    expect(listedBeads("## Beads\n\n- not-an-id? no\n* x-def.23 (mail half)\n")).toEqual([
      "x-def.23",
    ]);
    expect(listedBeads("## Other\n\n- x-abc.1\n")).toEqual([]);
    // Decorated as #35's review tried: bold, a link, emphasis; all found.
    expect(
      listedBeads(
        "## Beads\n\n- **x-def.11** x\n- [x-def.12](https://example.test) y\n- _x-abc.3_, z\n",
      ),
    ).toEqual(["x-def.11", "x-def.12", "x-abc.3"]);
  });

  test("the Gate is replaced and every other section kept as written", () => {
    const plan = planPrBody(filled, "fresh output");
    if ("problems" in plan) throw new Error(plan.problems.join("\n"));
    expect(plan.body).toBe(filled.replace("stale output", "fresh output"));
    expect(plan.beads).toEqual(["x-abc.1", "x-abc.2"]);
  });

  test("an unknown section of the agent's survives, and a missing Gate is put in its place", () => {
    const body = filled
      .replace("## Gate\n\nstale output\n\n", "")
      .replace("## Beads", "## Screenshots\n\nnone\n\n## Beads");
    const plan = planPrBody(body, "fresh");
    if ("problems" in plan) throw new Error(plan.problems.join("\n"));
    expect(plan.body).toContain(
      "## Evidence\n\nRan it on the real handoffs.\n\n## Gate\n\nfresh\n\n## Bug class closed",
    );
    expect(plan.body).toContain("## Screenshots\n\nnone\n\n## Beads");
  });

  test("a missing required section, or no bead listed, is refused with what to write", () => {
    const missing = planPrBody(filled.replace("## Not done\n\nNothing.\n\n", ""), "g");
    expect("problems" in missing ? missing.problems : []).toEqual([
      "the PR body lacks `## Not done`: add each heading with its text (a heading with only the template's placeholder counts as missing). The sections and what goes in each are in .github/pull_request_template.md",
    ]);
    // The template's placeholder is not text.
    const unfilled = planPrBody(prSkeleton(), "g");
    expect("problems" in unfilled ? unfilled.problems[0] : "").toContain(
      "lacks `## What changed and why`, `## Evidence`, `## Not done`, `## Beads`",
    );
    const noBeads = planPrBody(filled.replace(/- `x-abc.1`.*\n- x-abc.2: the second\n\n/, ""), "g");
    expect("problems" in noBeads ? noBeads.problems : []).toEqual([
      "the Beads section lists no bead: put each one this PR works on as a list item that starts with its id (`- <bead id> what it is`)",
    ]);
  });
});

describe("reviewedHead", () => {
  const head = "h".repeat(40);
  test("a thread reply (empty body) on the head isn't a review of it", () => {
    expect(reviewedHead([{ commit_id: head, body: "" }], head)).toBe(false);
    expect(reviewedHead([{ commit_id: head, body: "## Fit" }], head)).toBe(true);
  });
  test("once any review is marked, only marked ones count", () => {
    const marked = { commit_id: "o".repeat(40), body: `round 1\n\n${REVIEW_MARKER}` };
    expect(reviewedHead([marked, { commit_id: head, body: "the author's probe" }], head)).toBe(
      false,
    );
    expect(reviewedHead([marked, { commit_id: head, body: REVIEW_MARKER }], head)).toBe(true);
  });
});

describe("--body-only, behind, CI", () => {
  const tip = "a".repeat(40);
  test("gatedCommit reads the commit the Gate section ran on", () => {
    const withGate = prSkeleton({ Gate: gateSection("bun run check", tip, "ok") });
    expect(gatedCommit(withGate)).toBe("aaaaaaaaaaaa");
    expect(gatedCommit(prSkeleton({ Gate: "ran it by hand" }))).toBeUndefined();
  });
  test("bodyOnlyProblem: only when the gate ran on the tip and the tip is the PR's head", () => {
    expect(bodyOnlyProblem({ tip, head: tip, gated: "aaaaaaaaaaaa" })).toBeUndefined();
    expect(bodyOnlyProblem({ tip, head: "b".repeat(40), gated: "aaaaaaaaaaaa" })).toContain(
      "would leave the Gate section false",
    );
    expect(bodyOnlyProblem({ tip, head: tip, gated: "cccccccccccc" })).toContain(
      "would leave the Gate section false",
    );
    expect(bodyOnlyProblem({ tip, head: tip, gated: undefined })).toContain("has none");
  });
  test("behindWarning: nothing when up to date; the count, and conflicts when any", () => {
    expect(behindWarning({ target: "origin/main", behind: 0, conflicts: [] })).toBeUndefined();
    expect(behindWarning({ target: "origin/main", behind: 3, conflicts: undefined })).toContain(
      "3 commits behind `origin/main`.",
    );
    expect(behindWarning({ target: "origin/main", behind: 1, conflicts: ["a.ts"] })).toContain(
      "1 commit behind `origin/main`, and conflicts with it in a.ts.",
    );
  });
  test("ciState: none, running, done with what failed", () => {
    expect(ciState([]).kind).toBe("none");
    expect(ciState([{ id: 1, name: "c", status: "queued", conclusion: null }])).toEqual({
      kind: "running",
      pending: ["c"],
    });
    const done = ciState([
      { id: 1, name: "c", status: "completed", conclusion: "success" },
      { id: 2, name: "d", status: "completed", conclusion: "skipped" },
      { id: 3, name: "e", status: "completed", conclusion: "timed_out" },
    ]);
    expect(done.kind === "done" && done.failed).toEqual(["e (timed_out)"]);
  });
  test("ciState: only runs after the post answer it, judged by each check's latest run", () => {
    const old = { id: 1, name: "body", status: "completed", conclusion: "success" };
    // A body edit: the old run is done, and the rerun hasn't appeared yet.
    expect(ciState([old], new Set([1])).kind).toBe("none");
    const rerun = { id: 5, name: "body", status: "completed", conclusion: "failure" };
    const state = ciState([old, rerun], new Set([1]));
    expect(state.kind === "done" && state.failed).toEqual(["body (failure)"]);
  });
});

describe("gatePlan and the CI line", () => {
  const ci = "on:\n  pull_request:\njobs:\n  check:\n    steps:\n      - run: bun run check\n";
  const gate = "bun run typecheck && bun run lint && bun run shape && bun test";
  test("a pull_request workflow running the gate: the steps before bun test", () => {
    expect(gatePlan(gate, [ci])).toEqual({ kind: "fast", scripts: ["typecheck", "lint", "shape"] });
    // The scaffold's gate, as `mshape init` writes it.
    expect(gatePlan(`${gate} --pass-with-no-tests`, [ci])).toEqual({
      kind: "fast",
      scripts: ["typecheck", "lint", "shape"],
    });
  });
  test("anything else: the whole gate here", () => {
    expect(gatePlan(gate, [])).toEqual({ kind: "full" });
    expect(gatePlan(gate, ["on:\n  push:\n      - run: bun run check\n"])).toEqual({
      kind: "full",
    });
    expect(gatePlan("bun run typecheck && bun run lint", [ci])).toEqual({ kind: "full" });
    expect(gatePlan("tsc -p . && bun test", [ci])).toEqual({ kind: "full" });
    expect(gatePlan("bun run a; bun test", [ci])).toEqual({ kind: "full" });
    expect(gatePlan(undefined, [ci])).toEqual({ kind: "full" });
  });
  test("gatePlanCommand and the CI line", () => {
    expect(gatePlanCommand({ kind: "fast", scripts: ["a", "b"] })).toBe("bun run a && bun run b");
    expect(gatePlanCommand({ kind: "full" })).toBe("bun run check");
    const pending = gateSection("bun run a", "c".repeat(40), "ok", ciLine("c".repeat(40)));
    expect(pending).toContain("CI: runs the tests on cccccccccccc, not track pr");
    const done = withCiLine(
      pending,
      ciLine("c".repeat(40), [
        { id: 1, name: "check", status: "completed", conclusion: "success", html_url: "u" },
      ]),
    );
    expect(done).toContain("CI on cccccccccccc: check: success ([run](u)).");
    expect(done).not.toContain("runs the tests");
    expect(withCiLine(gateSection("bun run check", "c".repeat(40), "ok"), "x")).toBeUndefined();
  });
});
