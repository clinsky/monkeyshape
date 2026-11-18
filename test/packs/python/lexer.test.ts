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

  test("a raw string ending in an escaped backslash closes at its quote (review of #108)", () => {
    // `r"C:\\"` holds C: and two backslashes, then closes: a backslash in a
    // raw string still pairs with the next character, whatever it is.
    expect(comments("w = r\"C:\\\\\"  # one\nb = rb'\\\\'  # two\n")).toEqual([" one", " two"]);
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

  test("every import after a raw string ending in a backslash is read (review of #108)", () => {
    const text =
      'import re\nWIN = re.compile(r"C:\\\\")\n\nimport subprocess\nfrom app.io import disk\n';
    expect(read(text).map(([line, , module]) => [line, module])).toEqual([
      [1, "re"],
      [4, "subprocess"],
      [5, "app.io"],
    ]);
  });

  test("the scan is linear in the file's length (review of #108)", () => {
    // Best of three, so one slow run under the gate's parallel load doesn't decide it.
    const time = (lines: number) => {
      const text = `${"x = 1\n".repeat(lines)}import os\n`;
      let best = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 3; run++) {
        const started = performance.now();
        expect(read(text)).toEqual([[lines + 1, 0, "os", undefined]]);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    };
    const small = time(2_000);
    const large = time(20_000);
    // Ten times the lines: about ten times the time when linear, a hundred when quadratic.
    expect(large / Math.max(small, 1)).toBeLessThan(40);
  });

  test("an import in a string or a comment is none", () => {
    expect(read('s = \'import os\'\n# import sys\nt = """\nimport io\n"""\n')).toEqual([]);
  });

  test("words that only start like an import are none", () => {
    expect(read("imported = 1\nfrom_ = 2\nimport_x()\n")).toEqual([]);
  });
});
