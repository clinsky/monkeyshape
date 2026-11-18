/**
 * The Rust pack's loader: runs `cargo metadata --no-deps` at the repo root and reports the
 * files rustc compiles (clippy and rustfmt see the same mod tree). It never fails: a cargo
 * that can't run, or a workspace that isn't the repo's, is an integration state. The pure
 * part reads the recorded JSON under `CARGO_METADATA` for the crate graph.
 */
import { realpath } from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Integration } from "../../core/model.ts";
import { CARGO_METADATA, RUSTC } from "../../packs/rust/index.ts";
import { workspaceOf } from "../../packs/rust/metadata.ts";
import { reachedFiles } from "../../packs/rust/modTree.ts";
import { runTool } from "../process.ts";

export interface RustLoad {
  readonly tools: ReadonlyArray<{
    readonly tool: string;
    readonly integration: Integration;
    readonly files: ReadonlySet<string> | undefined;
  }>;
  readonly outputs: ReadonlyMap<string, string>;
}

const unloaded = (integration: Integration): RustLoad => ({
  tools: [{ tool: RUSTC, integration, files: undefined }],
  outputs: new Map(),
});

export const loadRust = (input: {
  readonly root: string;
  readonly repo: {
    readonly files: ReadonlyArray<string>;
    readonly texts: ReadonlyMap<string, string>;
  };
}): Effect.Effect<RustLoad> =>
  Effect.gen(function* () {
    const { files, texts } = input.repo;
    const sources = files.filter((file) => file.endsWith(".rs"));
    if (!files.includes("Cargo.toml"))
      return unloaded(
        sources.length === 0
          ? { state: "absent" }
          : {
              state: "failed",
              reason:
                "the repo has Rust sources but no Cargo.toml at its root; the Rust pack runs cargo there. Make the root a Cargo workspace (`[workspace]` with `members`).",
            },
      );
    const cargo = Bun.which("cargo");
    if (cargo === null)
      return unloaded({
        state: "unavailable",
        reason: "cargo is not on the PATH",
      });
    const ran = yield* runTool(input.root, [
      cargo,
      "metadata",
      "--no-deps",
      "--format-version",
      "1",
      "--offline",
    ]);
    if (ran.code !== 0)
      return unloaded({
        state: "failed",
        reason: `\`cargo metadata\` exited ${ran.code}: ${ran.stderr.trim().split("\n").slice(-3).join(" ")}`,
      });
    const workspace = workspaceOf(ran.stdout);
    if (Result.isFailure(workspace))
      return unloaded({ state: "failed", reason: workspace.failure });
    const realRoot = yield* Effect.promise(() => realpath(input.root));
    const root = workspace.success.root;
    if (root !== realRoot)
      return unloaded({
        state: "failed",
        reason: `cargo's workspace root is ${root}, not the repo's root ${realRoot}: the repo's Cargo.toml must be the workspace root (add \`[workspace]\` to it)`,
      });
    const roots = workspace.success.members.flatMap((crate) =>
      crate.targets.map((target) => target.root),
    );
    const sourceTexts = new Map(
      sources.flatMap((file) => {
        const text = texts.get(file);
        return text === undefined ? [] : [[file, text] as const];
      }),
    );
    return {
      tools: [
        { tool: RUSTC, integration: { state: "ok" }, files: reachedFiles(roots, sourceTexts) },
      ],
      outputs: new Map([[CARGO_METADATA, ran.stdout]]),
    };
  });
