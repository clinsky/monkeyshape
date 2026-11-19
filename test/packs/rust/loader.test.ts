import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { loadRust } from "../../../src/adapters/packs/rust.ts";
import { CARGO_METADATA, RUSTC } from "../../../src/packs/rust/index.ts";
import { skipWithout } from "../../support.ts";

const scratch = () => mkdtemp(join(tmpdir(), "rust-loader-"));

/** Writes `files` under `root` and loads them, every file's text in the snapshot. */
const load = async (root: string, files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  return Effect.runPromise(
    loadRust({ root, repo: { files: Object.keys(files), texts: new Map(Object.entries(files)) } }),
  );
};

const WORKSPACE = {
  "Cargo.toml": '[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n',
  "crates/core/Cargo.toml": '[package]\nname = "core"\nversion = "0.1.0"\nedition = "2024"\n',
  "crates/core/src/lib.rs": "pub mod inner;\n",
  "crates/core/src/inner.rs": "",
  "crates/core/src/orphan.rs": "",
  "crates/core/tests/it.rs": "",
};

describe("loadRust without cargo's help", () => {
  test("no Cargo.toml and no Rust: absent", async () => {
    const root = await scratch();
    try {
      const loaded = await load(root, { "README.md": "" });
      expect(loaded.tools[0]?.integration).toEqual({ state: "absent" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Rust sources but no root Cargo.toml: failed, saying what to add", async () => {
    const root = await scratch();
    try {
      const loaded = await load(root, { "src/lib.rs": "" });
      const integration = loaded.tools[0]?.integration;
      expect(integration?.state).toBe("failed");
      expect(integration?.state === "failed" && integration.reason).toContain("no Cargo.toml");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe.skipIf(skipWithout(Bun.which("cargo") !== null))("loadRust with cargo", () => {
  test("a workspace: rustc covers the mod tree and each target, not an orphan", async () => {
    const root = await scratch();
    try {
      const loaded = await load(root, WORKSPACE);
      const rustc = loaded.tools.find((tool) => tool.tool === RUSTC);
      expect(rustc?.integration).toEqual({ state: "ok" });
      expect([...(rustc?.files ?? [])].sort()).toEqual([
        "crates/core/src/inner.rs",
        "crates/core/src/lib.rs",
        "crates/core/tests/it.rs",
      ]);
      expect(loaded.outputs.get(CARGO_METADATA)).toContain('"workspace_root"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a repo inside another workspace: failed, naming both roots", async () => {
    const outer = await scratch();
    try {
      await Bun.write(join(outer, "Cargo.toml"), '[workspace]\nmembers = ["repo"]\n');
      const root = join(outer, "repo");
      const loaded = await load(root, {
        "Cargo.toml": '[package]\nname = "x"\nversion = "0.1.0"\nedition = "2024"\n',
        "src/lib.rs": "",
      });
      const integration = loaded.tools[0]?.integration;
      expect(integration?.state === "failed" && integration.reason).toContain(
        `cargo's workspace root is ${await realpath(outer)}, not the repo's root ${await realpath(root)}`,
      );
    } finally {
      await rm(outer, { recursive: true, force: true });
    }
  });

  test("a Cargo.toml cargo rejects: failed with cargo's words", async () => {
    const root = await scratch();
    try {
      const loaded = await load(root, { "Cargo.toml": "[package\n", "src/lib.rs": "" });
      const integration = loaded.tools[0]?.integration;
      expect(integration?.state === "failed" && integration.reason).toContain(
        "`cargo metadata` exited",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
