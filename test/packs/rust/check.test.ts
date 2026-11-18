import { describe, expect, test } from "bun:test";
import { runChecks } from "../../../src/core/check.ts";
import { CARGO_METADATA, RUSTC, rust } from "../../../src/packs/rust/index.ts";
import {
  type ResolvedConfig,
  resolveConfig,
  type ShapeConfig,
} from "../../../src/schemas/config.ts";
import { repo } from "../../support.ts";

// The workspace crateGraph.test.ts records: cli -> io; io -> core (as `kernel`), serde, libc
// (on unix), and cli as a build dependency; cli's dev-dependency on core is a test edge.
/** Resolved as the CLI resolves it: `sources` defaults from the listed pack. */
const config = (input: ShapeConfig): ResolvedConfig =>
  resolveConfig(input, "shape.toml", [], { rust: rust.defaultSources.include });

const metadata = await Bun.file(`${import.meta.dir}/fixtures/workspace.json`).text();

const FILES: Readonly<Record<string, string>> = {
  "Cargo.toml": '[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n',
  "crates/cli/Cargo.toml":
    '[package]\nname = "cli"\n\n[dependencies]\nio = { path = "../io" }\n\n[dev-dependencies]\ncore = { path = "../core" }\n',
  "crates/cli/src/main.rs": "fn main() {}\n",
  "crates/core/Cargo.toml": '[package]\nname = "core"\n\n[dependencies]\n',
  "crates/core/src/lib.rs": "pub mod inner;\n",
  "crates/core/src/inner/mod.rs": "",
  "crates/core/src/orphan.rs": "",
  "crates/core/tests/it.rs": "",
  "crates/io/Cargo.toml": [
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
  "crates/io/src/lib.rs": "",
};

const COMPILED = [
  "crates/cli/src/main.rs",
  "crates/core/src/lib.rs",
  "crates/core/src/inner/mod.rs",
  "crates/core/tests/it.rs",
  "crates/io/src/lib.rs",
];

const snapshot = repo(FILES, {
  packs: [
    {
      pack: rust,
      load: {
        tools: [{ tool: RUSTC, integration: { state: "ok" }, files: new Set(COMPILED) }],
        outputs: new Map([[CARGO_METADATA, metadata]]),
      },
    },
  ],
});

const shape = config({
  packs: ["rust"],
  arch: {
    modules: {
      core: { description: "the domain", paths: ["crates/core"] },
      io: {
        description: "the host",
        paths: ["crates/io"],
        mayImport: ["core"],
        packages: ["serde"],
      },
      cli: { description: "the binary", paths: ["crates/cli"], mayImport: ["core", "io"] },
    },
  },
});

describe("the Rust pack through mshape's checks", () => {
  test("arch judges the crate graph at the manifest lines", () => {
    const found = runChecks(shape, snapshot, ["arch"]).map((v) => [v.rule, v.file, v.line]);
    expect(found).toEqual(
      expect.arrayContaining([
        ["arch/forbidden-import", "crates/io/Cargo.toml", 12],
        ["arch/forbidden-package", "crates/io/Cargo.toml", 8],
        ["arch/cycle", "crates/cli/Cargo.toml", undefined],
      ]),
    );
    expect(found).toHaveLength(3);
  });

  test("an edge the map allows, and a dev-dependency, are not reported", () => {
    const allowed = config({
      packs: ["rust"],
      arch: {
        modules: {
          core: { description: "d", paths: ["crates/core"] },
          io: {
            description: "h",
            paths: ["crates/io"],
            mayImport: ["core", "cli"],
            packages: ["serde", "libc"],
          },
          cli: { description: "b", paths: ["crates/cli"], mayImport: ["io"] },
        },
      },
    });
    // Only the cycle through the build dependency is left: cli -> io -> cli.
    expect(runChecks(allowed, snapshot, ["arch"]).map((v) => v.rule)).toEqual(["arch/cycle"]);
  });

  test("coverage reports the file no mod reaches, and only it", () => {
    const found = runChecks(shape, snapshot, ["coverage"]).map((v) => [v.rule, v.file]);
    expect(found).toEqual([["coverage/compile", "crates/core/src/orphan.rs"]]);
  });

  test("every .rs file is in sources by the pack's default, and no rule misreads Rust", () => {
    expect(runChecks(shape, snapshot, ["sources", "rules"])).toEqual([]);
  });
});
