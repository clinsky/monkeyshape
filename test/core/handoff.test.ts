import { describe, expect, test } from "bun:test";
import { HANDOFF_SECTIONS, parseHandoff, stubHandoff } from "../../src/core/handoff.ts";

const stub = stubHandoff("docs", "2026-10-29", "/home/me/dev/emu/.agents/worktrees/emu@docs");

const active = `# Track: docs
Status: active
Queue: bd ready --label track:docs

## Charter

Write the user guide. Beads: \`iqf.15\`.

## State (2026-10-30)

Two pages drafted; the quick start is next.

## Lessons not yet promoted

- Examples rot unless a test runs them.

## Traps

None yet.

## Messages

- To \`init\`: the quick start needs \`init\` to print the next step.
`;

const problems = (text: string): ReadonlyArray<string> => {
  const parsed = parseHandoff(text);
  return "problems" in parsed ? parsed.problems : [];
};

describe("handoff format", () => {
  test("the stub parses: status stub, empty charter, every section", () => {
    const parsed = parseHandoff(stub);
    expect("problems" in parsed ? parsed.problems : []).toEqual([]);
    if ("problems" in parsed) return;
    expect(parsed.track).toBe("docs");
    expect(parsed.status).toBe("stub");
    expect(parsed.queue).toBe("bd ready --label track:docs");
    expect(parsed.stateDate).toBe("2026-10-29");
    expect(parsed.sections.Charter).toBe("");
    expect(parsed.sections.State).toContain("/track");
    expect(Object.keys(parsed.sections)).toEqual([...HANDOFF_SECTIONS]);
  });

  test("an active handoff parses, with each section's body", () => {
    const parsed = parseHandoff(active);
    expect("problems" in parsed ? parsed.problems : []).toEqual([]);
    if ("problems" in parsed) return;
    expect(parsed.status).toBe("active");
    expect(parsed.stateDate).toBe("2026-10-30");
    expect(parsed.sections.Charter).toBe("Write the user guide. Beads: `iqf.15`.");
    expect(parsed.sections.Messages).toStartWith("- To `init`");
  });

  test("a stub with a charter, or an active track without one, is refused", () => {
    expect(problems(stub.replace("## Charter\n", "## Charter\n\nDo things.\n"))).toEqual([
      "a stub has an empty charter: write the charter and set `Status: active`",
    ]);
    expect(problems(stub.replace("Status: stub", "Status: active"))).toEqual([
      "an active track needs a charter; until it has one, its status is `stub`",
    ]);
  });

  test("header departures are each reported", () => {
    expect(problems(active.replace("# Track: docs", "# Track: Docs"))).toContain(
      "track name `Docs` is not lowercase words joined by hyphens",
    );
    expect(problems(active.replace("Status: active", "Status: done"))).toContain(
      "`Status:` must be `stub` or `active`, found `done`",
    );
    expect(problems(active.replace("track:docs", "track:init"))).toEqual([
      "the queue must be `Queue: bd ready --label track:docs`, found `bd ready --label track:init`",
    ]);
    expect(problems(active.replace("Queue:", "Owner: me\nQueue:"))).toEqual([
      "only `Status:` and `Queue:` go between the title and `## Charter`; found `Owner: me`",
    ]);
  });

  test("sections must all be present, once, in order, with a dated State", () => {
    expect(problems(active.replace("## Traps\n\nNone yet.\n\n", ""))[0]).toStartWith(
      "sections must be exactly",
    );
    expect(problems(active.replace("## State (2026-10-30)", "## State (today)"))).toEqual([
      "the State heading's date must be `YYYY-MM-DD`, found `today`",
    ]);
    const swapped = active
      .replace("## Traps", "## TMP")
      .replace("## Messages", "## Traps")
      .replace("## TMP", "## Messages");
    expect(problems(swapped)[0]).toStartWith("sections must be exactly");
  });
});
