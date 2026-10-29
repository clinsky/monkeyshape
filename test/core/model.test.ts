import { describe, expect, test } from "bun:test";
import { isTsSource, lineAt, lineCount, pathIndex } from "../../src/core/model.ts";
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
