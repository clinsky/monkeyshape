import { describe, expect, test } from "bun:test";
import { CHECK_STAGE, formatCounts, gateStages, testCounts } from "../../src/core/gate.ts";
import { PACKS } from "../../src/packs/index.ts";
import type { GateStage, PackId } from "../../src/schemas/config.ts";
import { GATE_PACKS } from "./gatePacks.ts";

const config = (
  packs: ReadonlyArray<PackId>,
  stages: ReadonlyArray<GateStage> = [],
  prerequisites: Readonly<Record<string, "optional" | "required">> = {},
) => ({ packs, gate: { stages }, prerequisites });

const names = (stages: ReturnType<typeof gateStages>) =>
  stages.map((stage) => `${stage.fast ? "fast" : "full"}:${stage.name}`);

/** The plan's gate table, the rows that are about order and replacement. */
describe("gateStages", () => {
  test("fast: each pack's fast stages, mshape check, the repo's fast; then full: packs', the repo's", () => {
    const stages = gateStages(
      config(
        ["typescript"],
        [
          { name: "native", run: ["make", "check"], fast: false },
          { name: "spell", run: ["typos"], fast: true },
        ],
      ),
      GATE_PACKS,
    );
    expect(names(stages)).toEqual([
      "fast:tsc",
      "fast:biome",
      `fast:${CHECK_STAGE}`,
      "fast:spell",
      "full:bun-test",
      "full:native",
    ]);
  });

  test('packs = ["typescript", "python"]: both packs\' fast stages in packs order, then both packs\' tests', () => {
    expect(names(gateStages(config(["typescript", "python"]), GATE_PACKS))).toEqual([
      "fast:tsc",
      "fast:biome",
      "fast:ruff-format",
      "fast:ruff",
      "fast:ty",
      `fast:${CHECK_STAGE}`,
      "full:bun-test",
      "full:pytest",
    ]);
  });

  test("a repo stage with a pack stage's name replaces it, in its place and phase", () => {
    const stages = gateStages(
      config(["typescript"], [{ name: "bun-test", run: ["bun", "test", "--parallel"] }]),
      GATE_PACKS,
    );
    expect(names(stages)).toEqual([
      "fast:tsc",
      "fast:biome",
      `fast:${CHECK_STAGE}`,
      "full:bun-test",
    ]);
    const replaced = stages.at(-1);
    expect(replaced?.run).toEqual(["bun", "test", "--parallel"]);
    expect(replaced?.replaced).toBe(true);
    expect(replaced?.origin).toBe("typescript");
  });

  test("…unless it says fast: then it moves phase, keeping its place among its pack's stages", () => {
    const stages = gateStages(
      config(["typescript"], [{ name: "biome", run: ["biome", "lint", "."], fast: false }]),
      GATE_PACKS,
    );
    expect(names(stages)).toEqual([
      "fast:tsc",
      `fast:${CHECK_STAGE}`,
      "full:biome",
      "full:bun-test",
    ]);
  });

  test("a repo stage that sets no `fast` is in the full phase", () => {
    expect(
      names(gateStages(config(["rust"], [{ name: "e2e", run: ["./e2e.sh"] }]), GATE_PACKS)),
    ).toContain("full:e2e");
  });

  test("an optional prerequisite makes its stage's missing program a note; others are required", () => {
    const stages = gateStages(
      config(["typescript"], [], { tsc: "optional", biome: "required" }),
      GATE_PACKS,
    );
    const required = Object.fromEntries(stages.map((stage) => [stage.name, stage.required]));
    expect(required).toEqual({ tsc: false, biome: true, [CHECK_STAGE]: true, "bun-test": true });
  });

  test("any pack's tool can be made optional, each reaching the stage that stands for it (#110's review)", () => {
    const required = (id: "rust" | "python", key?: string) =>
      Object.fromEntries(
        gateStages(config([id], [], key === undefined ? {} : { [key]: "optional" }), GATE_PACKS)
          .filter((stage) => stage.origin === id)
          .map((stage) => [stage.name, stage.required]),
      );
    expect(required("rust")).toEqual({ "cargo-fmt": true, clippy: true, "cargo-test": true });
    // cargo stands for the toolchain, rustc; the clippy stage for clippy, by its name.
    expect(required("rust", "rustc")).toEqual({
      "cargo-fmt": false,
      clippy: true,
      "cargo-test": false,
    });
    expect(required("rust", "clippy")).toEqual({
      "cargo-fmt": true,
      clippy: false,
      "cargo-test": true,
    });
    // ruff and ty reach their stages, as they reach mshape check.
    expect(required("python", "ruff")).toMatchObject({ ruff: false, ty: true });
    expect(required("python", "ty")).toMatchObject({ ruff: true, ty: false });
  });

  test("a fresh born repo with no tests yet is green in every pack", () => {
    const tests = (stages: ReturnType<typeof gateStages>) => stages.filter((stage) => !stage.fast);
    expect(tests(gateStages(config(["typescript"]), PACKS))[0]?.run).toContain(
      "--pass-with-no-tests",
    );
    // cargo test passes a workspace with no tests; pytest exits 5 when it collects none.
    expect(tests(gateStages(config(["python"]), GATE_PACKS))[0]?.okExit).toEqual([0, 5]);
  });

  test("stage names are unique across packs, so a repo stage replaces exactly one", () => {
    const all = Object.values(GATE_PACKS).flatMap((pack) => pack.stages.map((stage) => stage.name));
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain(CHECK_STAGE);
  });
});

describe("a test stage's counts (z1u.14)", () => {
  test("bun test: pass, fail, and skip and todo as skipped", () => {
    const out =
      "bun test v1.4.2\n\n 1050 pass\n 2 skip\n 1 todo\n 0 fail\n 3120 expect() calls\nRan 1053 tests across 120 files. [41.2s]";
    expect(testCounts(out)).toEqual({ passed: 1050, failed: 0, skipped: 3 });
    expect(formatCounts({ passed: 1050, failed: 0, skipped: 3 })).toBe("1050 passed, 3 skipped");
  });

  test("cargo test: every crate's and the doc tests' result lines, summed", () => {
    const out = [
      "running 4 tests",
      "test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s",
      "   Doc-tests app",
      "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 2 filtered out; finished in 0.10s",
    ].join("\n");
    expect(testCounts(out)).toEqual({ passed: 6, failed: 1, skipped: 3 });
  });

  test("pytest: the last summary line; no tests ran is 0, the silent skip #131 hid", () => {
    expect(
      testCounts(
        "collected 5 items\n...\n==== 3 passed, 1 skipped, 1 xfailed, 2 warnings in 0.05s ====",
      ),
    ).toEqual({ passed: 3, failed: 0, skipped: 2 });
    expect(testCounts("= 1 failed, 2 passed, 1 error in 1.20s =")).toEqual({
      passed: 2,
      failed: 2,
      skipped: 0,
    });
    const none = testCounts("collected 0 items\n\n==== no tests ran in 0.01s ====");
    expect(none).toEqual({ passed: 0, failed: 0, skipped: 0 });
    expect(formatCounts(none ?? { passed: 1, failed: 1, skipped: 1 })).toBe("0 passed");
  });

  test("output no runner here wrote, like tsc's or biome's, has no counts", () => {
    expect(testCounts("Checked 225 files in 207ms. No fixes applied.")).toBeUndefined();
    expect(testCounts("")).toBeUndefined();
  });
});
