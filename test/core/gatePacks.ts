/**
 * The gate's packs for its tests: the registry's TypeScript pack, and the plan's Rust and
 * Python stage tables (plan/MILESTONE.md, `mshape gate`) until those packs ship their own.
 */
import type { GatePacks } from "../../src/core/gate.ts";
import { PACKS } from "../../src/packs/index.ts";

export const GATE_PACKS: GatePacks = {
  ...PACKS,
  rust: {
    stages: [
      { name: "cargo-fmt", run: ["cargo", "fmt", "--all", "--check"], fast: true },
      {
        name: "clippy",
        run: ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
        fast: true,
      },
      { name: "cargo-test", run: ["cargo", "test", "--workspace"] },
    ],
    prerequisites: [{ name: "cargo", required: true, install: "rustup (https://rustup.rs)" }],
  },
  python: {
    stages: [
      { name: "ruff-format", run: ["uv", "run", "ruff", "format", "--check"], fast: true },
      { name: "ruff-check", run: ["uv", "run", "ruff", "check"], fast: true },
      { name: "ty", run: ["uv", "run", "ty", "check"], fast: true },
      { name: "pytest", run: ["uv", "run", "pytest"], okExit: [0, 5] },
    ],
    prerequisites: [{ name: "uv", required: true, install: "uv, then `uv sync`" }],
  },
};
