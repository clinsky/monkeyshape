import { describe, expect, test } from "bun:test";
import { prSkeleton } from "../../src/core/conventions.ts";
import {
  changedLines,
  GATE_TAIL_LINES,
  gateSection,
  listedBeads,
  planPrBody,
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
    expect(listedBeads("## Beads\n\n- not-an-id? no\n* monkeyshape-f4y.23 (mail half)\n")).toEqual([
      "monkeyshape-f4y.23",
    ]);
    expect(listedBeads("## Other\n\n- x-abc.1\n")).toEqual([]);
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
