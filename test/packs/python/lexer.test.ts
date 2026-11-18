import { describe, expect, test } from "bun:test";
import { importsOf } from "../../../src/packs/python/imports.ts";
import { lex } from "../../../src/packs/python/lexer.ts";

const comments = (text: string) => lex(text).comments.map((comment) => comment.text);

describe("the Python lexer", () => {
  test("a comment, and a # inside every kind of string, which is none", () => {
    const text = [
      "x = 1  # one",
      "a = '#no'",
      'b = "#no"',
      'c = """',
      "# no",
      '"""',
      "d = r'\\'#no'",
      "e = rb'#no'",
      "# two",
    ].join("\n");
    expect(comments(text)).toEqual([" one", " two"]);
  });

  test("offsets are UTF-16 indices into the text, after a character outside the BMP", () => {
    const text = 's = "🙂"  # here\n';
    const [comment] = lex(text).comments;
    expect(text.slice(comment?.start, comment?.end)).toBe("# here");
  });

  test("an f-string's fields are code, and their own strings nest", () => {
    const text = [
      'f"{x["#k"]} # no"  # one',
      "f'{a:{w}} {{#no}}'  # two",
      "f'''{'#no'}'''  # three",
    ].join("\n");
    expect(comments(text)).toEqual([" one", " two", " three"]);
  });

  test("a name ending in a prefix letter is not a prefix: `br` before a quote in `abr'...'`", () => {
    // `abr` is a name, so the quote opens a plain string, not a bytes-raw one.
    expect(comments("abr = 1\nx = abr'\\'#no'\n# yes\n")).toEqual([" yes"]);
  });

  test("an unterminated string ends at its line, and the next line is code again", () => {
    expect(comments("x = 'open\n# yes\n")).toEqual([" yes"]);
  });

  test("blanked code keeps every offset and newline", () => {
    const text = "a = 'xy'  # c\nb = 2\n";
    const { code } = lex(text);
    expect(code.length).toBe(text.length);
    expect(code).toBe("a = '  '     \nb = 2\n");
  });
});

const read = (text: string) =>
  importsOf(text).map(({ line, level, module, names }) => [line, level, module, names]);

describe("Python's import statements", () => {
  test("plain imports, aliases and several per statement", () => {
    expect(read("import os\nimport a.b as c, d\n")).toEqual([
      [1, 0, "os", undefined],
      [2, 0, "a.b", undefined],
      [2, 0, "d", undefined],
    ]);
  });

  test("from-imports: relative, parenthesised across lines, aliased, starred", () => {
    const text = [
      "from . import x",
      "from ..pkg.mod import (",
      "    a,",
      "    b as bee,",
      ")",
      "from m import *",
    ].join("\n");
    expect(read(text)).toEqual([
      [1, 1, "", ["x"]],
      [2, 2, "pkg.mod", ["a", "b"]],
      [6, 0, "m", ["*"]],
    ]);
  });

  test("inside a function, an if block, after `;`, and after a backslash", () => {
    const text = [
      "def f():",
      "    import json",
      "if TYPE_CHECKING: from a import B",
      "x = 1; import y",
      "from z \\",
      "    import w",
    ].join("\n");
    expect(read(text)).toEqual([
      [2, 0, "json", undefined],
      [3, 0, "a", ["B"]],
      [4, 0, "y", undefined],
      [5, 0, "z", ["w"]],
    ]);
  });

  test("an import in a string or a comment is none", () => {
    expect(read('s = \'import os\'\n# import sys\nt = """\nimport io\n"""\n')).toEqual([]);
  });

  test("words that only start like an import are none", () => {
    expect(read("imported = 1\nfrom_ = 2\nimport_x()\n")).toEqual([]);
  });
});
