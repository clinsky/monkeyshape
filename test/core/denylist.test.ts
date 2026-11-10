import { describe, expect, test } from "bun:test";
import {
  denylistRefusal,
  findings,
  gitPath,
  parseDenylist,
  parsePatch,
  REFUSAL_PLACES,
  scanText,
} from "../../src/core/denylist.ts";

// Invented terms only: the real list is never in a repo.
const TERMS = ["zorblax", "Quuxcorp"];

describe("parseDenylist", () => {
  test("one term per line; blank lines and # comments are ignored; terms are trimmed", () => {
    expect(
      parseDenylist("# private names\nzorblax\n\n  quuxcorp  \r\n   # indented comment\n"),
    ).toEqual(["zorblax", "quuxcorp"]);
  });
});

describe("scanText", () => {
  test("case-insensitive substrings, with 1-based line and column", () => {
    expect(scanText("ok\nthe ZORBLAX repo and quuxCorp.io\n", TERMS)).toEqual([
      { line: 2, column: 5, term: "zorblax" },
      { line: 2, column: 22, term: "Quuxcorp" },
    ]);
  });

  test("every occurrence on a line, inside a word too", () => {
    expect(scanText("zorblaxzorblax", ["zorblax"]).map((hit) => hit.column)).toEqual([1, 8]);
  });

  test("columns count UTF-16 code units, as JS strings do", () => {
    expect(scanText("é zorblax", ["zorblax"])[0]?.column).toBe(3);
  });

  test("no terms, no hits", () => {
    expect(scanText("zorblax", [])).toEqual([]);
  });
});

describe("gitPath", () => {
  test("bare, or C-quoted with escapes and octal UTF-8 bytes", () => {
    expect(gitPath("plain name.md").path).toBe("plain name.md");
    expect(gitPath('"a\\"b\\\\c\\td\\303\\251.md" rest')).toEqual({
      path: 'a"b\\c\tdé.md',
      rest: " rest",
    });
  });
});

describe("parsePatch", () => {
  test("added lines with their numbers, and the paths it adds", () => {
    const commit = parsePatch(
      [
        "diff --git a/new file.md b/new file.md",
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/new file.md",
        "@@ -0,0 +1,2 @@",
        "+first",
        "+second",
        "diff --git a/old.md b/old.md",
        "index 1..2 100644",
        "--- a/old.md",
        "+++ b/old.md",
        "@@ -3 +3 @@",
        "-gone",
        "+++ an added line that starts with two pluses",
        "\\ No newline at end of file",
        "diff --git a/a.md b/renamed.md",
        "similarity index 100%",
        "rename from a.md",
        "rename to renamed.md",
        "diff --git a/empty.md b/empty.md",
        "new file mode 100644",
        "index 0000000..e69de29",
      ].join("\n"),
    );
    expect(commit.paths).toEqual(["new file.md", "renamed.md", "empty.md"]);
    expect(commit.added).toEqual([
      { path: "new file.md", line: 1, text: "first" },
      { path: "new file.md", line: 2, text: "second" },
      { path: "old.md", line: 3, text: "++ an added line that starts with two pluses" },
    ]);
  });

  test("a merge's combined diff: only lines new against every parent are its own", () => {
    const merge = parsePatch(
      [
        "diff --cc shared.md",
        "index 1,2..3",
        "--- a/shared.md",
        "+++ b/shared.md",
        "@@@ -1,1 -1,1 +1,3 @@@",
        "- ours",
        " -theirs",
        "++resolved by hand",
        " +from main",
        "+ from the branch",
      ].join("\n"),
    );
    expect(merge.added).toEqual([{ path: "shared.md", line: 1, text: "resolved by hand" }]);
    expect(merge.paths).toEqual([]);
  });

  test("an empty patch adds nothing", () => {
    expect(parsePatch("")).toEqual({ added: [], paths: [] });
  });
});

describe("findings", () => {
  const commit = {
    sha: "c".repeat(40),
    message: "Fix the Zorblax import",
    paths: ["notes/quuxcorp.md"],
    added: [{ path: "src/a.ts", line: 4, text: "// for zorblax" }],
  };

  test("names where each term is: a text's line and column, the commit, the file and line, the path", () => {
    expect(
      findings(
        {
          commits: [commit],
          texts: [
            { name: "the PR title", text: "Quuxcorp support" },
            { name: "the PR body", text: "## Why\n\nzorblax asked" },
          ],
        },
        TERMS,
      ),
    ).toEqual([
      'the PR title, line 1, column 1: "Quuxcorp"',
      'the PR body, line 3, column 1: "zorblax"',
      'the message of commit cccccccccccc, line 1, column 9: "zorblax"',
      'the path notes/quuxcorp.md, added by commit cccccccccccc, column 7: "Quuxcorp"',
      'src/a.ts:4:8, added by commit cccccccccccc: "zorblax"',
    ]);
  });

  test("an empty list finds nothing", () => {
    expect(findings({ commits: [commit], texts: [] }, [])).toEqual([]);
  });

  test("the refusal says what wasn't done, lists each place and how to rewrite a commit", () => {
    const refusal = denylistRefusal(['the PR title, line 1, column 1: "x"'], "nothing was pushed");
    expect(refusal).toContain("a denylisted term would leave the machine, so nothing was pushed");
    expect(refusal).toContain('  the PR title, line 1, column 1: "x"');
    expect(refusal).toContain("git commit --amend");
  });

  test("the refusal lists the first REFUSAL_PLACES places and counts the rest", () => {
    const many = Array.from({ length: REFUSAL_PLACES + 3 }, (_, i) => `place ${i}`);
    const refusal = denylistRefusal(many, "nothing was pushed");
    expect(refusal).toContain(`  place ${REFUSAL_PLACES - 1}\n  and 3 more\n`);
    expect(refusal).not.toContain(`place ${REFUSAL_PLACES}\n`);
  });
});
