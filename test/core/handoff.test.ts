import { describe, expect, test } from "bun:test";
import {
  HANDOFF_SECTIONS,
  migrateHandoff,
  parseHandoff,
  stubHandoff,
} from "../../src/core/handoff.ts";

const made = stubHandoff("docs", "2026-10-29", "/home/me/dev/emu/.agents/worktrees/emu@docs");
const stub = "text" in made ? made.text : "";

const charter = `Serves: goal 2, because adopters can't start without a guide.
Out of scope: the API reference.
Done means: the quick start runs on a clean machine.

Beads: \`iqf.15\`.`;

const active = `# Track: docs
Queue: bd ready --label track:docs

## Charter

${charter}

## State (2026-10-30)

Two pages drafted; the quick start is next.

## Lessons not yet promoted

- Examples rot unless a test runs them.

## Traps

None yet.
`;

const problems = (text: string): ReadonlyArray<string> => {
  const parsed = parseHandoff(text);
  return "problems" in parsed ? parsed.problems : [];
};

describe("handoff format", () => {
  test("the stub parses: a stub, with an empty charter and every section", () => {
    const parsed = parseHandoff(stub);
    expect("problems" in parsed ? parsed.problems : []).toEqual([]);
    if ("problems" in parsed) return;
    expect(parsed.track).toBe("docs");
    expect(parsed.stub).toBe(true);
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
    expect(parsed.stub).toBe(false);
    expect(parsed.stateDate).toBe("2026-10-30");
    expect(parsed.sections.Charter).toBe(charter);
    expect(parsed.sections.Traps).toBe("None yet.");
  });

  test("a charter opens with Serves (and because), Out of scope and Done means, in order", () => {
    const with_ = (text: string) => problems(active.replace(charter, text));
    // Each label's value may wrap onto the next lines.
    expect(
      with_(
        "Serves: goal 2,\nbecause adopters need it.\nOut of scope:\nthe API.\nDone means: it runs.",
      ),
    ).toEqual([]);
    expect(with_("Write the user guide.")[0]).toStartWith(
      "a charter opens with `Serves: ...`, `Out of scope: ...`, `Done means: ...`, in that order; its first line is `Write the user guide.`",
    );
    expect(with_("Serves: goal 2, because x.\nDone means: y.")).toEqual([
      "a charter opens with `Serves: ...`, `Out of scope: ...`, `Done means: ...`; add `Out of scope:` after `Serves:`",
    ]);
    expect(with_("Serves: goal 2, because x.\nDone means: y.\nOut of scope: z.")).toEqual([
      "a charter opens with `Serves: ...`, `Out of scope: ...`, `Done means: ...`, in that order: reorder them",
    ]);
    expect(with_("Serves: goal 2.\nOut of scope: z.\nDone means: y.")).toEqual([
      "the charter's `Serves:` line says which goal steps and why, as `Serves: <goal steps>, because <why this track, now>`",
    ]);
    expect(with_("Serves: goal 2, because x.\nOut of scope:\nDone means:\n\nBeads.")).toEqual([
      "the charter's `Out of scope:` line is empty: say it",
      "the charter's `Done means:` line is empty: say it",
    ]);
  });

  test("the older format is refused with the way out: Status and Messages are gone", () => {
    expect(problems(active.replace("Queue:", "Status: active\nQueue:"))).toEqual([
      "`Status:` is gone: a stub is a handoff with an empty charter, and done is derived. Run `mshape track list`, which migrates the old format",
    ]);
    expect(problems(`${active}\n## Messages\n\nNone yet.\n`)).toEqual([
      "`## Messages` is gone: tracks message each other with `mshape msg send`. Run `mshape track list`, which moves the section into the track's mailbox",
    ]);
  });

  test("migration drops Status and Messages, carrying any messages, and runs once", () => {
    const old = `${active.replace("Queue:", "Status: active\nQueue:")}\n## Messages\n\n- From init (2026-10-30): print the next step.\n`;
    const migrated = migrateHandoff(old);
    expect(migrated?.text).toBe(active);
    expect(migrated?.carried).toBe("- From init (2026-10-30): print the next step.");
    expect(migrated?.changes).toEqual([
      "moved `## Messages` into the track's mailbox",
      "removed `Status: active`",
    ]);
    expect(migrateHandoff(active)).toBeUndefined();
    // A section that said nothing is dropped with nothing to carry.
    const empty = migrateHandoff(`${active}\n## Messages\n\nNone open. Use mshape msg.\n`);
    expect(empty?.text).toBe(active);
    expect(empty?.carried).toBeUndefined();
    // A `## Messages` quoted in a fence is not the section.
    const quoting = active.replace("None yet.", "```md\n## Messages\n```");
    expect(migrateHandoff(quoting)).toBeUndefined();
    // Messages in the middle: the sections after it stay.
    const middle = active.replace("## Traps", "## Messages\n\n- hi\n\n## Traps");
    expect(migrateHandoff(middle)?.text).toBe(active);
  });

  test("header departures are each reported", () => {
    expect(problems(active.replace("# Track: docs", "# Track: Docs"))).toContain(
      "track name `Docs` is not lowercase words joined by hyphens",
    );
    expect(problems(active.replace("track:docs", "track:init"))).toEqual([
      "the queue must be `Queue: bd ready --label track:docs`, found `bd ready --label track:init`",
    ]);
    expect(problems(active.replace("Queue:", "Owner: me\nQueue:"))).toEqual([
      "only `Queue:` goes between the title and `## Charter`; found `Owner: me`",
    ]);
  });

  test("sections must all be present, once, in order, with a dated State", () => {
    expect(problems(active.replace("## Traps\n\nNone yet.\n", ""))[0]).toStartWith(
      "sections must be exactly",
    );
    expect(problems(active.replace("## State (2026-10-30)", "## State (today)"))).toEqual([
      "the State heading's date must be a real day as `YYYY-MM-DD`, found `today`",
    ]);
    expect(problems(active.replace("## State (2026-10-30)", "## State (2026-02-29)"))).toEqual([
      "the State heading's date must be a real day as `YYYY-MM-DD`, found `2026-02-29`",
    ]);
    expect(problems(active.replace("(2026-10-30)", "(2028-02-29)"))).toEqual([]);
    expect(problems(active.replace("## State (2026-10-30)", "## State"))).toEqual([
      "the State heading needs a date: `## State (YYYY-MM-DD)`",
    ]);
    const swapped = active
      .replace("## Traps", "## TMP")
      .replace("## Lessons not yet promoted", "## Traps")
      .replace("## TMP", "## Lessons not yet promoted");
    expect(problems(swapped)[0]).toStartWith("sections must be exactly");
  });

  test("a `##` line inside a fenced block in a body is not a heading", () => {
    for (const fence of ["```", "~~~~"]) {
      const quoting = active.replace(
        "None yet.",
        `An example:\n\n${fence}md\n## Notes\n${fence}\n`,
      );
      expect(problems(quoting)).toEqual([]);
    }
  });

  test("an unclosed fence is named with its line, not only as missing sections", () => {
    const unclosed = active.replace("- Examples rot", "```md\n- Examples rot");
    const line = unclosed.split("\n").indexOf("```md") + 1;
    expect(problems(unclosed)[0]).toBe(
      `a code fence opened on line ${line} is never closed, which hides every heading after it: close it with a matching fence`,
    );
  });

  test("fences follow CommonMark: no info string on a closer, at most three spaces of indent", () => {
    // ```ts inside an open fence doesn't close it, so the later ``` does and `## Notes` stays hidden.
    const nested = active.replace("None yet.", "```md\n```ts\n## Notes\n```\n");
    expect(problems(nested)).toEqual([]);
    // Indented four spaces it is indented code, not a fence: nothing is left open.
    const indented = active.replace("None yet.", "    ```\ncode");
    expect(problems(indented)).toEqual([]);
  });

  test("a duplicate Queue line is reported as a duplicate", () => {
    const queues = active.replace("Queue:", "Queue: bd ready --label track:docs\nQueue:");
    expect(problems(queues)).toEqual(["`Queue:` appears 2 times; keep one"]);
  });

  test("a leading BOM and trailing spaces on the title are tolerated", () => {
    expect(problems(`\uFEFF${active.replace("# Track: docs", "# Track: docs  ")}`)).toEqual([]);
  });

  test("the stub refuses a bad name or date where it is made", () => {
    const bad = (track: string, date: string) => {
      const result = stubHandoff(track, date, "/w");
      return "problems" in result ? result.problems : [];
    };
    expect(bad("Docs", "2026-10-29")[0]).toContain("track name `Docs`");
    expect(bad("docs", "2026-13-45")[0]).toContain("found `2026-13-45`");
    expect(bad("docs", "2026-10-29")).toEqual([]);
  });
});
