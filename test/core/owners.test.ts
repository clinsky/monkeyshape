import { describe, expect, test } from "bun:test";
import { prSkeleton } from "../../src/core/conventions.ts";
import {
  namedOwners,
  otherOwners,
  ownerMessage,
  ownerNotices,
  ownersLine,
  parseDiff,
  parseFileOwners,
  revertedLines,
  revertedProblem,
  withOwnersLine,
} from "../../src/core/owners.ts";

const PLAN = `# Milestone

### Layout

| Path | What | Owner |
|---|---|---|
| \`src/x.ts\` | not this table | other |

### File owners (\`prs\`, \`z1u.10\`)

Prose first, naming \`| Path | Track |\` inline.

| Path | Track |
|---|---|
| \`src/core/mail.ts\` | notices |
| \`src/harnesses/codex/**\` | codex |
| \`src/harnesses/**\` | harness |
| \`src/core/trackPr.ts\` | prs |
| \`plan/**\` | main |

| Case | Result |
|---|---|
| a | b |
`;

const rows = parseFileOwners(PLAN)?.rows ?? [];

describe("the File owners table", () => {
  test("reads the first | Path | Track | table under the heading, not an earlier one", () => {
    expect(rows.map((row) => `${row.path}=${row.track}`)).toEqual([
      "src/core/mail.ts=notices",
      "src/harnesses/codex/**=codex",
      "src/harnesses/**=harness",
      "src/core/trackPr.ts=prs",
      "plan/**=main",
    ]);
    expect(parseFileOwners(PLAN)?.skipped).toEqual([]);
  });

  test("no plan heading, or a heading with no such table: undefined", () => {
    expect(parseFileOwners("# Plan\n\n| Path | Track |\n|---|---|\n| a | b |\n")).toBeUndefined();
    expect(
      parseFileOwners("### File owners\n\nNone yet.\n\n## Next\n\n| Path | Track |\n|---|---|\n"),
    ).toBeUndefined();
    expect(
      parseFileOwners("```\n### File owners\n| Path | Track |\n|---|---|\n| a | b |\n```\n"),
    ).toBeUndefined();
  });

  test("a malformed row is skipped and named; the rest apply", () => {
    const parsed = parseFileOwners(
      "### File owners\n\n| Path | Track |\n|---|---|\n| `a/**` | one |\n| `b` | Not A Track |\n| `c` |\n| | two |\n| `d` | three |\n",
    );
    expect(parsed?.rows.map((row) => row.path)).toEqual(["a/**", "d"]);
    expect(parsed?.skipped).toEqual(["| `b` | Not A Track |", "| `c` |", "| | two |"]);
  });

  test("the first matching row wins; a path no row matches is no one's", () => {
    const owned = otherOwners(
      [
        "src/harnesses/codex/hooks.ts",
        "src/harnesses/index.ts",
        "src/cli/main.ts",
        "src/core/trackPr.ts",
      ],
      rows,
      "prs",
    );
    expect(owned).toEqual([
      { file: "src/harnesses/codex/hooks.ts", owner: "codex" },
      { file: "src/harnesses/index.ts", owner: "harness" },
    ]);
  });
});

describe("the owners notice", () => {
  const mail = { file: "src/core/mail.ts", owner: "notices" };
  const hooks = { file: "src/harnesses/hooks.ts", owner: "harness" };
  const codex = { file: "src/harnesses/codex/a.ts", owner: "codex" };

  test("only its own files: no line", () => {
    expect(ownersLine([])).toBeUndefined();
    expect(withOwnersLine("```\ngate\n```", undefined)).toBe("```\ngate\n```");
  });

  test("another track's file: the line names file and track, and that track is mailed", () => {
    const line = ownersLine([mail]) ?? "";
    expect(line).toContain("`src/core/mail.ts` (notices)");
    const body = prSkeleton({ Gate: withOwnersLine("```\ngate\n```\n\nCI: pending", line) });
    expect(namedOwners(body)).toEqual([mail]);
    expect([...ownerNotices([], [mail])]).toEqual([["notices", ["src/core/mail.ts"]]]);
  });

  test("a later push touching the same set mails no one; a third track's file mails that track only", () => {
    expect(ownerNotices([mail, hooks], [mail, hooks]).size).toBe(0);
    expect([...ownerNotices([mail, hooks], [mail, hooks, codex])]).toEqual([
      ["codex", ["src/harnesses/codex/a.ts"]],
    ]);
  });

  test("a refreshed line replaces the old one, and a push that drops every file drops it", () => {
    const gate = withOwnersLine("```\ngate\n```", ownersLine([mail]));
    const again = withOwnersLine(gate, ownersLine([mail, hooks]));
    expect(again.match(/Other tracks' files/g)?.length).toBe(1);
    expect(namedOwners(prSkeleton({ Gate: again }))).toEqual([mail, hooks]);
    expect(withOwnersLine(again, undefined)).toBe("```\ngate\n```");
  });

  test("the message names the PR, the files, and that no answer is wanted", () => {
    const message = ownerMessage({ number: 9, url: "https://example.test/pr/9" }, "prs", ["a.ts"]);
    expect(message.subject).toBe("#9 from prs edits your files: `a.ts`");
    expect(message.body).toContain("https://example.test/pr/9");
    expect(message.body).toContain("reply only if");
    const many = ownerMessage(
      { number: 9, url: "u" },
      "prs",
      Array.from({ length: 20 }, (_, i) => `src/a/long/path/${i}.ts`),
    );
    expect(many.subject).toBe("#9 from prs edits 20 of your files");
  });
});

describe("a squash onto a moved main (jhz.4)", () => {
  const gained = parseDiff(
    [
      "diff --git a/plan/M.md b/plan/M.md",
      "--- a/plan/M.md",
      "+++ b/plan/M.md",
      "@@ -10,0 +11,2 @@",
      "+## Amendments",
      "+- another track's amendment",
      "diff --git a/src/core/trackPr.ts b/src/core/trackPr.ts",
      "--- a/src/core/trackPr.ts",
      "+++ b/src/core/trackPr.ts",
      "@@ -1,0 +2 @@",
      "+main's line in our file",
    ].join("\n"),
  );
  const removing = parseDiff(
    [
      "diff --git a/plan/M.md b/plan/M.md",
      "--- a/plan/M.md",
      "+++ b/plan/M.md",
      "@@ -11,2 +10,0 @@",
      "-## Amendments",
      "-- another track's amendment",
      "@@ -20 +18 @@",
      "-a line main had all along",
      "+its edit",
      "diff --git a/src/core/trackPr.ts b/src/core/trackPr.ts",
      "--- a/src/core/trackPr.ts",
      "+++ b/src/core/trackPr.ts",
      "@@ -2 +1,0 @@",
      "-main's line in our file",
    ].join("\n"),
  );

  test("lines main gained that the push removes, in a file the track doesn't own: named with their lines", () => {
    const reverted = revertedLines(gained, removing, (file) => file === "src/core/trackPr.ts");
    expect(reverted).toEqual([{ file: "plan/M.md", lines: [11, 12] }]);
    const problem = revertedProblem(reverted, "a".repeat(40), "c".repeat(40), "b".repeat(40));
    expect(problem).toContain("plan/M.md (lines 11-12 at aaaaaaaaaaaa)");
    expect(problem).toContain("git reset --soft bbbbbbbbbbbb");
  });

  test("an edit of a line main had before, and the track's own file: not refused", () => {
    expect(revertedLines(new Map(), removing, () => false)).toEqual([]);
    expect(revertedLines(gained, removing, () => true)).toEqual([]);
  });

  test("a removal of a line equal to one main gained elsewhere in the file: not refused (#145's review)", () => {
    // main gained `}` at line 26 of base; the PR removed the old `}` at line 4.
    const gainedBrace = parseDiff(
      "diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ b/n.ts\n@@ -23,0 +24,3 @@\n+g(() => {\n+  b();\n+}\n",
    );
    const removingBrace = parseDiff(
      "diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ b/n.ts\n@@ -4 +3,0 @@\n-}\n",
    );
    expect(revertedLines(gainedBrace, removingBrace, () => false)).toEqual([]);
    const removingNew = parseDiff(
      "diff --git a/n.ts b/n.ts\n--- a/n.ts\n+++ b/n.ts\n@@ -26 +25,0 @@\n-}\n",
    );
    expect(revertedLines(gainedBrace, removingNew, () => false)).toEqual([
      { file: "n.ts", lines: [26] },
    ]);
  });

  test("a deleted file's lines are under its old path", () => {
    const deleted = parseDiff("diff --git a/x b/x\n--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-gone\n");
    expect(deleted.get("x")?.removed).toEqual([{ line: 1, text: "gone" }]);
  });
});
