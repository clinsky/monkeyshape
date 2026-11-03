import { expect, test } from "bun:test";
import { join } from "node:path";
import { parseHandoff, stubHandoff } from "../../src/core/handoff.ts";

// The `milestone` skill fills each new track's stub handoff from its example. If the example
// drifts from the format `parseHandoff` enforces, every track a milestone creates starts out
// invalid in `mshape track list`.
const skill = await Bun.file(
  join(import.meta.dir, "..", "..", "skills", "milestone", "SKILL.md"),
).text();

/** The skill's ```markdown example, de-indented out of its list item. */
const example = (): string => {
  const lines = skill.split("\n");
  const open = lines.findIndex((line) => line.trim() === "```markdown");
  const close = lines.findIndex((line, index) => index > open && line.trim() === "```");
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  const indent = (lines[open] ?? "").length - (lines[open] ?? "").trimStart().length;
  return lines
    .slice(open + 1, close)
    .map((line) => line.slice(indent))
    .join("\n");
};

test("a stub filled as the milestone skill's example shows parses as an active handoff", () => {
  const stub = stubHandoff("export", "2026-01-15", "/repo/.agents/worktrees/repo@export");
  if ("problems" in stub) throw new Error(stub.problems.join("\n"));
  // What the skill says to fill: the charter and the state; the sections after them stay.
  const filled = stub.text.replace(
    /^## Charter\n[\s\S]*?(?=^## Lessons not yet promoted$)/m,
    `${example()}\n\n`,
  );
  expect(filled).not.toBe(stub.text);
  const parsed = parseHandoff(filled);
  expect("problems" in parsed ? parsed.problems : []).toEqual([]);
  if ("problems" in parsed) return;
  expect(parsed.sections.Charter.split("\n")[0]).toStartWith("Serves:");
});
