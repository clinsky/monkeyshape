import { describe, expect, test } from "bun:test";
import { modDeclarations, reachedFiles } from "../../../src/packs/rust/modTree.ts";

const reached = (files: Record<string, string>, roots = ["src/lib.rs"]) =>
  [...reachedFiles(roots, new Map(Object.entries(files)))].sort();

describe("modDeclarations", () => {
  test("finds out-of-line mods, not inline ones or other items", () => {
    const text = "pub mod a;\npub(crate) mod b;\nmod c { fn f() {} }\nfn mod_like() {}\n";
    expect(modDeclarations(text).map((d) => d.name)).toEqual(["a", "b"]);
  });

  test("skips mods in comments, strings, raw strings and char literals", () => {
    const text = [
      "// mod a;",
      "/* mod b; /* nested */ mod c; */",
      'const S: &str = "mod d;";',
      'const R: &str = r#"mod e; "quoted" "#;',
      "const C: char = '\"'; mod f;",
      "fn g<'a>(x: &'a str) {} mod h;",
    ].join("\n");
    expect(modDeclarations(text).map((d) => d.name)).toEqual(["f", "h"]);
  });

  test("records enclosing inline modules and #[path]", () => {
    const text = 'mod outer { #[path = "x.rs"] mod a; mod b; }\nmod c;\n#[cfg(test)]\nmod tests;';
    expect(modDeclarations(text).map((d) => [d.name, d.inline, d.path])).toEqual([
      ["a", ["outer"], "x.rs"],
      ["b", ["outer"], undefined],
      ["c", [], undefined],
      ["tests", [], undefined],
    ]);
  });

  test("a raw identifier names its file without r#", () => {
    expect(modDeclarations("mod r#type;").map((d) => d.name)).toEqual(["type"]);
  });

  test("a macro's `mod $name;` is not a declaration", () => {
    expect(modDeclarations("macro_rules! m { ($n:ident) => { mod $n; } }")).toEqual([]);
  });
});

describe("reachedFiles", () => {
  // The fixture rustc's dep-info was checked against: it lists lib.rs, inner/mod.rs, odd.rs
  // and inline/deep.rs, and not orphan.rs.
  test("matches what rustc compiles", () => {
    expect(
      reached({
        "src/lib.rs": 'pub mod inner; #[path="odd.rs"] mod weird; mod inline { mod deep; }',
        "src/inner/mod.rs": "pub fn x() {}",
        "src/odd.rs": "",
        "src/inline/deep.rs": "",
        "src/orphan.rs": "",
      }),
    ).toEqual(["src/inline/deep.rs", "src/inner/mod.rs", "src/lib.rs", "src/odd.rs"]);
  });

  test("a non-mod.rs file keeps its children in its own directory", () => {
    expect(
      reached({
        "src/lib.rs": "mod a;",
        "src/a.rs": "mod b;",
        "src/a/b.rs": "",
        "src/b.rs": "",
      }),
    ).toEqual(["src/a.rs", "src/a/b.rs", "src/lib.rs"]);
  });

  test("foo.rs is preferred over foo/mod.rs, and either is found", () => {
    expect(reached({ "src/lib.rs": "mod a; mod b;", "src/a.rs": "", "src/b/mod.rs": "" })).toEqual([
      "src/a.rs",
      "src/b/mod.rs",
      "src/lib.rs",
    ]);
  });

  test("every target root is a root, and a missing file is skipped", () => {
    expect(
      reached({ "src/main.rs": "mod gone;", "tests/it.rs": "mod common;", "tests/common.rs": "" }, [
        "src/main.rs",
        "tests/it.rs",
      ]),
    ).toEqual(["src/main.rs", "tests/common.rs", "tests/it.rs"]);
  });

  test("a #[path] file holds its children beside it", () => {
    expect(
      reached({
        "src/lib.rs": '#[path = "gen/x.rs"] mod x;',
        "src/gen/x.rs": "mod y;",
        "src/gen/y.rs": "",
      }),
    ).toEqual(["src/gen/x.rs", "src/gen/y.rs", "src/lib.rs"]);
  });
});
