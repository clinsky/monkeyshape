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
    expect(modDeclarations(text).map((d) => [d.name, d.inline.map((b) => b.name), d.path])).toEqual(
      [
        ["a", ["outer"], "x.rs"],
        ["b", ["outer"], undefined],
        ["c", [], undefined],
        ["tests", [], undefined],
      ],
    );
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

  // Each case below is what rustc 1.100's dep-info listed, or the file its error asked for;
  // each was reported as coverage/compile before (review of #102).
  test("include! reads a file relative to the including file's directory", () => {
    expect(
      reached({
        "src/lib.rs": 'mod a;\ninclude!("gen.rs");',
        "src/gen.rs": "",
        "src/a.rs": 'include!("inc.rs");',
        "src/inc.rs": "",
        "src/a/inc.rs": "",
      }),
    ).toEqual(["src/a.rs", "src/gen.rs", "src/inc.rs", "src/lib.rs"]);
  });

  test("an include! of a computed path, or inside a string, is not followed", () => {
    expect(
      reached({
        "src/lib.rs":
          'include!(concat!(env!("OUT_DIR"), "/x.rs"));\nconst S: &str = "include!(\\"y.rs\\")";',
        "src/x.rs": "",
        "src/y.rs": "",
      }),
    ).toEqual(["src/lib.rs"]);
  });

  test("every cfg_attr path is compiled on some platform", () => {
    expect(
      reached({
        "src/lib.rs":
          '#[cfg_attr(unix, path = "plat_unix.rs")]\n#[cfg_attr(windows, path = "plat_win.rs")]\nmod plat;',
        "src/plat_unix.rs": "",
        "src/plat_win.rs": "",
        "src/plat.rs": "",
      }),
    ).toEqual(["src/lib.rs", "src/plat.rs", "src/plat_unix.rs", "src/plat_win.rs"]);
  });

  test("#[path] on an inline block, in a mod.rs file and in another", () => {
    expect(
      reached({
        "src/lib.rs": '#[path = "other"]\nmod k { mod l; }\nmod a;',
        "src/other/l.rs": "",
        "src/k/l.rs": "",
        "src/a.rs": '#[path = "k2"] mod k { mod m; }',
        "src/k2/m.rs": "",
        "src/a/k2/m.rs": "",
      }),
    ).toEqual(["src/a.rs", "src/k2/m.rs", "src/lib.rs", "src/other/l.rs"]);
  });
});
