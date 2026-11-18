/**
 * The Rust pack: cargo metadata for the crates and their graph, the mod tree for what rustc
 * compiles, clippy and rustfmt as gate stages, and the curated workspace lints, which `sync`
 * keeps in the root `Cargo.toml`.
 */
import * as Result from "effect/Result";
import type { Edge, Pack, PackFinding } from "../pack.ts";
import { crateEdges } from "./crateGraph.ts";
import { lex } from "./lexer.ts";
import { effectiveLints, LINT_TABLES, memberFindings, renderLints } from "./lints.ts";
import { workspaceOf } from "./metadata.ts";

/** The name the loader records `cargo metadata`'s JSON under. */
export const CARGO_METADATA = "cargo-metadata";

/** The tool whose file list coverage holds every `.rs` source to. */
export const RUSTC = "rustc";

/**
 * A crate's tests, benches and examples: compiled by cargo, layered by no module. kindOf sees
 * only the path, not cargo's targets, so it goes by the last of these or `src` in it.
 */
const TEST_DIRECTORIES = new Set(["tests", "benches", "examples"]);

const tomlOf = (text: string): unknown => {
  try {
    return Bun.TOML.parse(text);
  } catch {
    return undefined;
  }
};

const workspaceIn = (outputs: ReadonlyMap<string, string>) => {
  const json = outputs.get(CARGO_METADATA);
  if (json === undefined) return undefined;
  const workspace = workspaceOf(json);
  return Result.isSuccess(workspace) ? workspace.success : undefined;
};

export const rust: Pack = {
  id: "rust",
  language: "Rust",
  kindOf: (file) => {
    if (!file.endsWith(".rs")) return undefined;
    // The last of `src`, `tests`, `benches` and `examples` in the path says which: a member
    // crate at `examples/demo/src/` is source, and `crates/a/tests/it.rs` is a test.
    const directories = file.split("/").slice(0, -1);
    const last = directories.findLast(
      (segment) => segment === "src" || TEST_DIRECTORIES.has(segment),
    );
    return last !== undefined && TEST_DIRECTORIES.has(last) ? "test" : "source";
  },
  comments: (file) => lex(file.text).comments,
  // rustc reports syntax errors in clippy's stage, with its own spans.
  syntaxErrors: () => [],
  defaultSources: { include: ["**/*.rs"] },
  // Host access in Rust is a `use` of std::fs, std::process, std::net or std::env: not yet
  // read, so `hostUses` is empty and host-access passes every Rust module.
  hostSpecifiers: [],
  graph: (input) => {
    const workspace = workspaceIn(input.outputs);
    if (workspace === undefined) return { edges: [], hostUses: [] };
    return {
      edges: crateEdges(workspace, input.texts).map((edge): Edge => edge),
      hostUses: [],
    };
  },
  tools: [
    {
      name: RUSTC,
      rule: "compile",
      uncovered: (config) =>
        `is compiled by no crate of this workspace: no \`mod\` declaration or \`include!\` reaches it from a target's root (lib.rs, main.rs, a test, bench, example or build script), so rustc, clippy and rustfmt never see it. Declare it with \`mod <name>;\` in its parent module, or delete it. If it belongs to a package this workspace doesn't build (one under \`exclude\`, such as cargo-fuzz's \`fuzz/\`), check it with a command in \`coverage.commands\` in ${config.configFile}, e.g. \`{ files = ["fuzz/**"], run = ["cargo", "clippy", "--manifest-path", "fuzz/Cargo.toml", "--", "-D", "warnings"] }\`. If only a macro reaches it, list it in \`coverage.exempt-files\` with that reason.`,
    },
  ],
  findings: ({ repo, load }) => {
    const workspace = workspaceIn(load.outputs);
    if (workspace === undefined) return [];
    return memberFindings(
      workspace.members.map((crate) => crate.manifest),
      repo.texts,
      tomlOf,
    ).map((finding): PackFinding => finding);
  },
  findingKinds: ["member-lints"],
  rules: [],
  baseConfigs: [
    {
      delivery: "table",
      file: "Cargo.toml",
      tables: LINT_TABLES,
      content: (config) => renderLints(effectiveLints(config.rust?.lints)),
    },
  ],
  template: "template/packs/rust",
  stages: [
    { name: "fmt", run: ["cargo", "fmt", "--all", "--check"], fast: true },
    {
      name: "clippy",
      run: ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      fast: true,
    },
    { name: "test", run: ["cargo", "test", "--workspace"] },
  ],
  // `rustc` is the tool coverage names, so the core finds its install hint by that name;
  // rustup brings cargo with it. clippy and rustfmt are rustup components the stages need:
  // rustup installs a `cargo-clippy` proxy even without the component, so whoever checks
  // these must run `cargo clippy --version`, not look the program up.
  prerequisites: [
    {
      name: RUSTC,
      required: true,
      install: "install Rust with rustup (https://rustup.rs), which brings cargo and rustc",
    },
    {
      name: "clippy",
      required: true,
      install: "`rustup component add clippy`, or list it in rust-toolchain.toml's `components`",
    },
    {
      name: "rustfmt",
      required: true,
      install: "`rustup component add rustfmt`, or list it in rust-toolchain.toml's `components`",
    },
  ],
  loadFor: ["arch", "coverage"],
};
