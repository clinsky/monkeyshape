import { describe, expect, test } from "bun:test";
import {
  classify,
  type FileClass,
  type FileMode,
  isTsSource,
  lineAt,
  lineCount,
  pathIndex,
} from "../../src/core/model.ts";
import { parse } from "../../src/core/parse.ts";

describe("lineAt", () => {
  test("agrees with offsets oxc-parser actually returns, past non-ASCII and astral text", () => {
    const text = '// é, 漢字 and 😀 before\nconst s = "😀😀";\n/* ü */ throw x;\n';
    const parsed = parse("non-ascii.ts", text);
    const comments = parsed.comments.map((c) => lineAt(text, c.start));
    const statements = parsed.program.body.map((node) => lineAt(text, node.start));
    expect(comments).toEqual([1, 3]);
    expect(statements).toEqual([2, 3]);
    const thrown = parsed.program.body[1];
    expect(thrown === undefined ? "" : text.slice(thrown.start, thrown.end)).toBe("throw x;");
  });

  test("counts UTF-16 code units, the unit oxc offsets use", () => {
    const text = "// é and 😀\nconst x = 1;\n";
    expect(lineAt(text, text.indexOf("const"))).toBe(2);
  });
});

describe("lineCount", () => {
  test("ignores the trailing newline", () => {
    expect(lineCount("a\nb\n")).toBe(2);
    expect(lineCount("a\nb")).toBe(2);
    expect(lineCount("")).toBe(0);
  });
});

describe("pathIndex", () => {
  test("holds files and every ancestor directory", () => {
    const index = pathIndex(["src/core/a.ts"]);
    expect([...index].sort()).toEqual(["src", "src/core", "src/core/a.ts"]);
  });
});

describe("isTsSource", () => {
  test("declaration files are not sources", () => {
    expect(isTsSource("src/a.ts")).toBe(true);
    expect(isTsSource("src/a.tsx")).toBe(true);
    expect(isTsSource("src/a.d.ts")).toBe(false);
    expect(isTsSource("src/a.js")).toBe(false);
  });
});

describe("classify", () => {
  // The plan's file classes, as a table: path, git's mode, class.
  const cases: ReadonlyArray<readonly [string, FileMode | undefined, FileClass]> = [
    ["src/a.ts", undefined, "typescript"],
    ["src/types.d.ts", undefined, "typescript"],
    ["native/x.c", undefined, "executable"],
    ["native/x.H", undefined, "executable"],
    ["tools/gen.py", undefined, "executable"],
    ["eslint.config.mjs", undefined, "executable"],
    [".github/scripts/release", "executable", "executable"],
    [".github/scripts/release.sh", undefined, "executable"],
    ["bin/run", "executable", "executable"],
    ["scripts/x.ts", "executable", "typescript"],
    [".github/workflows/ci.yml", undefined, "data"],
    ["package.json", undefined, "data"],
    ["config/x.toml", undefined, "data"],
    [".beads/hooks/pre-commit", "executable", "builtin"],
    [".beads/issues.jsonl", undefined, "builtin"],
    [".gitignore", undefined, "builtin"],
    ["data/.gitkeep", undefined, "builtin"],
    ["sub/.gitattributes", undefined, "builtin"],
    [".gitmodules", undefined, "builtin"],
    [".claude/skills", "symlink", "builtin"],
    ["link.py", "symlink", "builtin"],
    [".github/CODEOWNERS", undefined, "metadata"],
    [".github-notes.md", undefined, "metadata"],
    ["template/gitignore", undefined, "metadata"],
    ["bun.lock", undefined, "metadata"],
    ["LICENSE", undefined, "metadata"],
    ["docs/a.md", undefined, "metadata"],
    ["assets/logo.png", undefined, "metadata"],
    [".env.example", undefined, "metadata"],
    [".c", undefined, "metadata"],
  ];
  for (const [path, mode, expected] of cases)
    test(`${path}${mode === undefined ? "" : ` (${mode})`} is ${expected}`, () => {
      expect(classify(path, mode)).toBe(expected);
    });
});
