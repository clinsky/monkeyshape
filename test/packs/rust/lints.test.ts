import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CURATED,
  effectiveLints,
  memberFindings,
  renderLints,
} from "../../../src/packs/rust/lints.ts";

const parse = (text: string): unknown => {
  try {
    return Bun.TOML.parse(text);
  } catch {
    return undefined;
  }
};

describe("renderLints", () => {
  test("is TOML whose value is the lints, under workspace.lints", () => {
    expect(parse(renderLints(CURATED))).toEqual({ workspace: { lints: CURATED } });
  });

  test("an override replaces one lint's level and keeps the rest", () => {
    const lints = effectiveLints({ clippy: { todo: "allow", unwrap_used: "warn" } });
    expect(lints.clippy["todo"]).toBe("allow");
    expect(lints.clippy["unwrap_used"]).toBe("warn");
    expect(lints.clippy["dbg_macro"]).toBe("warn");
    expect(lints.rust).toEqual(CURATED.rust);
  });
});

describe("memberFindings", () => {
  const manifests = ["a/Cargo.toml", "b/Cargo.toml", "c/Cargo.toml", "d/Cargo.toml"];
  const texts = new Map([
    ["a/Cargo.toml", '[package]\nname = "a"\n\n[lints]\nworkspace = true\n'],
    ["b/Cargo.toml", '[package]\nname = "b"\n'],
    ["c/Cargo.toml", '[package]\nname = "c"\n\n[lints.clippy]\ntodo = "allow"\n'],
    ["d/Cargo.toml", "[package\n"],
  ]);

  test("holds each member to `workspace = true`, at its [lints] line or line 1", () => {
    const found = memberFindings(manifests, texts, parse);
    expect(found.map((finding) => [finding.file, finding.line])).toEqual([
      ["b/Cargo.toml", 1],
      ["c/Cargo.toml", 1],
    ]);
    expect(found[0]?.message).toContain("Add `[lints]` with `workspace = true`");
  });

  test("a manifest that doesn't parse is cargo's to report", () => {
    expect(memberFindings(["d/Cargo.toml"], texts, parse)).toEqual([]);
  });
});

// The curated lints must pass on a fresh `cargo new`, or every born Rust repo starts red.
const cargo = Bun.which("cargo");
const clippy = cargo !== null && Bun.spawnSync([cargo, "clippy", "--version"]).exitCode === 0;

describe.skipIf(!clippy)("the curated lints on a real workspace", () => {
  test("a fresh member is green, and a dbg! fails clippy's stage", async () => {
    const root = await mkdtemp(join(tmpdir(), "rust-lints-"));
    try {
      await Bun.write(
        join(root, "Cargo.toml"),
        `[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n\n${renderLints(CURATED)}\n`,
      );
      const run = (args: ReadonlyArray<string>) =>
        Bun.spawnSync([cargo ?? "cargo", ...args], {
          cwd: root,
          env: { ...process.env, CARGO_TARGET_DIR: join(root, "target") },
        });
      expect(run(["new", "-q", "--lib", "crates/one"]).exitCode).toBe(0);
      // cargo new opts a member into the workspace's lints by itself.
      const manifest = "crates/one/Cargo.toml";
      const texts = new Map([[manifest, await Bun.file(join(root, manifest)).text()]]);
      expect(memberFindings([manifest], texts, parse)).toEqual([]);
      const stage = [
        "clippy",
        "-q",
        "--workspace",
        "--all-targets",
        "--offline",
        "--",
        "-D",
        "warnings",
      ];
      const green = run(stage);
      expect(green.stderr.toString()).toBe("");
      expect(green.exitCode).toBe(0);

      const lib = join(root, "crates/one/src/lib.rs");
      await Bun.write(lib, `${await Bun.file(lib).text()}\npub fn f() { dbg!(1); }\n`);
      const red = run(stage);
      expect(red.exitCode).not.toBe(0);
      expect(red.stderr.toString()).toContain("clippy::dbg_macro");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);
});
