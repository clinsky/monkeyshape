import { describe, expect, test } from "bun:test";
import { rust } from "../../../src/packs/rust/index.ts";

describe("rust.kindOf", () => {
  test("a crate's tests, benches and examples are tests, its src is source", () => {
    expect(
      [
        "crates/a/src/lib.rs",
        "crates/a/tests/it.rs",
        "crates/a/tests/common/mod.rs",
        "crates/a/benches/b.rs",
        "crates/a/examples/e.rs",
        "crates/a/build.rs",
        "src/main.rs",
      ].map(rust.kindOf),
    ).toEqual(["source", "test", "test", "test", "test", "source", "source"]);
  });

  // The review of #102: `members = ["crates/*", "examples/*"]` is a common layout.
  test("a member crate under examples/ or tests/ is source in its src/, tests in its tests/", () => {
    expect(
      ["examples/demo/src/lib.rs", "examples/demo/tests/it.rs", "tests/harness/src/main.rs"].map(
        rust.kindOf,
      ),
    ).toEqual(["source", "test", "source"]);
  });

  test("not Rust: not claimed", () => {
    expect(rust.kindOf("crates/a/Cargo.toml")).toBeUndefined();
  });
});
