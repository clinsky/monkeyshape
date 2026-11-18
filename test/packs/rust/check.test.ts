import { describe, expect, test } from "bun:test";
import { runChecks } from "../../../src/core/check.ts";
import { SYNC_COMMAND } from "../../../src/core/hooks.ts";
import { CARGO_METADATA, RUSTC, rust } from "../../../src/packs/rust/index.ts";
import { CURATED, renderLints } from "../../../src/packs/rust/lints.ts";
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

  // The review of #102: files rustc does compile, or another workspace builds, that the mod
  // tree can't reach. Each has a way out that coverage honours, and the message names both.
  describe("what the mod tree can't reach", () => {
    const withFuzz = repo(
      { ...FILES, "fuzz/Cargo.toml": '[package]\nname = "f"\n', "fuzz/fuzz_targets/t1.rs": "" },
      {
        packs: [
          {
            pack: rust,
            load: {
              tools: [{ tool: RUSTC, integration: { state: "ok" }, files: new Set(COMPILED) }],
              outputs: new Map([[CARGO_METADATA, metadata]]),
            },
          },
        ],
      },
    );
    const compile = (input: ShapeConfig) =>
      runChecks(config(input), withFuzz, ["coverage"])
        .filter((v) => v.rule === "coverage/compile")
        .map((v) => v.file);

    test("a nested workspace's file is reported, and the message says how to check it", () => {
      expect(compile({ packs: ["rust"] })).toEqual([
        "crates/core/src/orphan.rs",
        "fuzz/fuzz_targets/t1.rs",
      ]);
      const [first] = runChecks(config({ packs: ["rust"] }), withFuzz, ["coverage"]);
      expect(first?.message).toContain("`coverage.commands` in shape.toml");
      expect(first?.message).toContain("`coverage.exempt-files`");
    });

    test("a declared command that checks it, or an exemption with a reason, excuses it", () => {
      expect(
        compile({
          packs: ["rust"],
          coverage: {
            commands: [
              {
                files: ["fuzz/**"],
                run: ["cargo", "clippy", "--manifest-path", "fuzz/Cargo.toml"],
              },
            ],
            exemptFiles: [
              { path: "crates/core/src/orphan.rs", reason: "reached only by a macro's mod" },
            ],
          },
        }),
      ).toEqual([]);
    });
  });

  // The review of #102: following member-lints' advice before the root defines the tables
  // breaks cargo ("`workspace.lints` was not defined").
  describe("the workspace's lints", () => {
    const packs = (files: Readonly<Record<string, string>>) =>
      runChecks(shape, repo(files, { packs: snapshot.packs.map((loaded) => loaded) }), ["packs"]);

    test("a root without [workspace.lints]: one finding there, saying to run sync, none on members", () => {
      const found = packs(FILES);
      expect(found.map((v) => [v.rule, v.file])).toEqual([
        ["packs/rust/workspace-lints", "Cargo.toml"],
      ]);
      expect(found[0]?.message).toContain(
        `Run \`${SYNC_COMMAND}\`, which writes [workspace.lints.rust]`,
      );
    });

    // 8il.21: once sync has run here, its own check reports a missing table; one finding.
    test("where sync has run, the sync check owns a missing table, not workspace-lints", () => {
      expect(packs({ ...FILES, ".agents/skills/monkeyshape.json": "{}" })).toEqual([]);
    });

    test("once the root has them, each member without the opt-in is reported", () => {
      const found = packs({
        ...FILES,
        "Cargo.toml": `${FILES["Cargo.toml"]}\n${renderLints(CURATED)}\n`,
      });
      expect(found.map((v) => [v.rule, v.file])).toEqual([
        ["packs/rust/member-lints", "crates/cli/Cargo.toml"],
        ["packs/rust/member-lints", "crates/core/Cargo.toml"],
        ["packs/rust/member-lints", "crates/io/Cargo.toml"],
      ]);
    });

    test("a member that opted in too early breaks cargo: the root's finding still says what to add", () => {
      const found = runChecks(
        shape,
        repo(FILES, { packs: [{ pack: rust, load: { tools: [], outputs: new Map() } }] }),
        ["packs"],
      );
      expect(found.map((v) => v.rule)).toEqual(["packs/rust/workspace-lints"]);
    });

    test("a root with one owned table: the finding names the other, members are judged", () => {
      const rustOnly = renderLints(CURATED).split("\n\n")[0] ?? "";
      const found = packs({ ...FILES, "Cargo.toml": `${FILES["Cargo.toml"]}\n${rustOnly}\n` });
      expect(found.map((v) => [v.rule, v.file])).toEqual([
        ["packs/rust/workspace-lints", "Cargo.toml"],
        ["packs/rust/member-lints", "crates/cli/Cargo.toml"],
        ["packs/rust/member-lints", "crates/core/Cargo.toml"],
        ["packs/rust/member-lints", "crates/io/Cargo.toml"],
      ]);
      expect(found[0]?.message).toStartWith("lacks [workspace.lints.clippy]");
    });
  });
});
