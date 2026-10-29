import { describe, expect, test } from "bun:test";
import { isTsSource, lineAt, lineCount, pathIndex } from "../../src/core/model.ts";

describe("lineAt", () => {
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
