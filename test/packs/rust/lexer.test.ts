import { describe, expect, test } from "bun:test";
import { lex } from "../../../src/packs/rust/lexer.ts";

const comments = (text: string) =>
  lex(text).comments.map((comment) => [comment.kind, comment.text]);

describe("lex: comments", () => {
  test("line and doc comments, to the line's end", () => {
    expect(comments("// a\n/// doc\n//! inner\nfn f() {} // tail")).toEqual([
      ["line", " a"],
      ["line", "/ doc"],
      ["line", "! inner"],
      ["line", " tail"],
    ]);
  });

  test("a block comment nests, and is one comment", () => {
    expect(comments("/* a /* b */ c */ fn f() {}")).toEqual([["block", " a /* b */ c "]]);
  });

  test("an unclosed block comment runs to the end", () => {
    expect(comments("fn f() {} /* open")).toEqual([["block", " open"]]);
  });

  test("markers inside strings, raw strings and chars aren't comments", () => {
    const text = [
      'let a = "// not";',
      'let b = r#"/* not */"#;',
      "let c = '/';",
      'let d = b"//";',
      "// yes",
    ].join("\n");
    expect(comments(text)).toEqual([["line", " yes"]]);
  });

  test("a lifetime doesn't open a char literal that swallows a comment", () => {
    expect(comments("fn f<'a>(x: &'a str) {} // yes")).toEqual([["line", " yes"]]);
  });

  test("offsets are UTF-16 indices into the text", () => {
    const text = 'let s = "😀"; // shape-ignore x: why';
    const [comment] = lex(text).comments;
    expect(comment?.start).toBe(text.indexOf("//"));
    expect(text.slice(comment?.start, comment?.end)).toBe("// shape-ignore x: why");
  });

  test("a char literal holding a multi-byte character", () => {
    expect(comments("let c = '😀'; // yes")).toEqual([["line", " yes"]]);
  });
});
