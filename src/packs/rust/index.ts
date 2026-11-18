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

/** A crate's tests, benches and examples: compiled by cargo, layered by no module. */
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
    return file
      .split("/")
      .slice(0, -1)
      .some((segment) => TEST_DIRECTORIES.has(segment))
      ? "test"
      : "source";
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
      uncovered: () =>
        "is compiled by no crate: no `mod` declaration reaches it from a target's root (lib.rs, main.rs, a test, bench, example or build script), so rustc, clippy and rustfmt never see it. Declare it with `mod <name>;` in its parent module, or delete it.",
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
  prerequisites: [
    { name: "cargo", required: true, install: "install Rust with rustup: https://rustup.rs" },
    {
      name: "cargo-clippy",
      required: true,
      install: "`rustup component add clippy` (or list it in rust-toolchain.toml's components)",
    },
    {
      name: "rustfmt",
      required: true,
      install: "`rustup component add rustfmt` (or list it in rust-toolchain.toml's components)",
    },
  ],
  loadFor: ["arch", "coverage"],
};
