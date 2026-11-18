import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import { crateEdges, declarationLine } from "../../../src/packs/rust/crateGraph.ts";
import { workspaceOf } from "../../../src/packs/rust/metadata.ts";

// `cargo metadata --no-deps --format-version 1` (cargo 1.100) over a three-crate workspace,
// its root rewritten to /repo. The manifests below are the ones it was recorded from.
const metadata = await Bun.file(`${import.meta.dir}/fixtures/workspace.json`).text();

const manifests = new Map([
  [
    "crates/cli/Cargo.toml",
    '[package]\nname = "cli"\n\n[dependencies]\nio = { path = "../io" }\n\n[dev-dependencies]\ncore = { path = "../core" }\n',
  ],
  ["crates/core/Cargo.toml", '[package]\nname = "core"\n\n[dependencies]\n'],
  [
    "crates/io/Cargo.toml",
    [
      "[package]",
      'name = "io"',
      "",
      "[dependencies]",
      'kernel = { path = "../core", package = "core" }',
      "serde.workspace = true",
      "",
      "[target.'cfg(unix)'.dependencies.libc]",
      'version = "0.2"',
      "",
      "[build-dependencies]",
      'cli = { path = "../cli" }',
      "",
    ].join("\n"),
  ],
]);

const workspace = () => {
  const result = workspaceOf(metadata);
  if (Result.isFailure(result)) throw new Error(result.failure);
  return result.success;
};

describe("workspaceOf", () => {
  test("reads members with repo-relative manifests and target roots", () => {
    const members = workspace().members;
    expect(members.map((crate) => [crate.name, crate.manifest, crate.directory])).toEqual([
      ["cli", "crates/cli/Cargo.toml", "crates/cli"],
      ["core", "crates/core/Cargo.toml", "crates/core"],
      ["io", "crates/io/Cargo.toml", "crates/io"],
    ]);
    expect(members.find((crate) => crate.name === "core")?.targets).toEqual([
      { name: "core", kind: "lib", root: "crates/core/src/lib.rs" },
      { name: "it", kind: "test", root: "crates/core/tests/it.rs" },
    ]);
  });

  test("resolves a path dependency to the member it names, under its rename", () => {
    const io = workspace().members.find((crate) => crate.name === "io");
    expect(io?.dependencies.find((dependency) => dependency.key === "kernel")).toEqual({
      package: "core",
      key: "kernel",
      kind: "normal",
      member: "crates/core/Cargo.toml",
    });
  });

  test("text that isn't cargo's JSON fails with a reason, never throws", () => {
    expect(Result.isFailure(workspaceOf("warning: something"))).toBe(true);
    const wrong = workspaceOf('{"workspace_root": 1}');
    expect(Result.isFailure(wrong) && wrong.failure).toContain("isn't what the Rust pack reads");
  });

  test("a field cargo adds later is ignored", () => {
    const extended = JSON.stringify({ ...JSON.parse(metadata), added_in_cargo_2: true });
    expect(Result.isSuccess(workspaceOf(extended))).toBe(true);
  });
});

describe("crateEdges", () => {
  test("member and package edges at their lines; dev-dependencies left out", () => {
    expect(crateEdges(workspace(), manifests)).toEqual([
      { from: "crates/cli/Cargo.toml", line: 5, written: "io", to: "crates/io/Cargo.toml" },
      { from: "crates/io/Cargo.toml", line: 5, written: "kernel", to: "crates/core/Cargo.toml" },
      { from: "crates/io/Cargo.toml", line: 6, written: "serde", package: "serde" },
      { from: "crates/io/Cargo.toml", line: 8, written: "libc", package: "libc" },
      { from: "crates/io/Cargo.toml", line: 12, written: "cli", to: "crates/cli/Cargo.toml" },
    ]);
  });

  test("a manifest the snapshot lacks puts its edges on line 1", () => {
    const edges = crateEdges(workspace(), new Map());
    expect(edges.every((edge) => edge.line === 1)).toBe(true);
  });
});

describe("declarationLine", () => {
  test("finds quoted keys, and ignores the same key in another table or a comment", () => {
    const text = '[package]\nfoo = 1\n[dependencies]\n# foo = "1"\n"foo" = "2"\n';
    expect(declarationLine(text, "foo", "normal")).toBe(5);
    expect(declarationLine(text, "foo", "build")).toBeUndefined();
  });
});
