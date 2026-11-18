import { describe, expect, test } from "bun:test";
import { CHECK_STAGE, gateStages } from "../../src/core/gate.ts";
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
      "fast:ruff-check",
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

  test("any pack's tool can be made optional, not only tsc and biome", () => {
    const stages = gateStages(config(["rust"], [], { cargo: "optional" }), GATE_PACKS);
    expect(
      stages.filter((stage) => stage.origin === "rust").every((stage) => !stage.required),
    ).toBe(true);
    // Unset, it is as the pack declares it: cargo is required.
    expect(gateStages(config(["rust"]), GATE_PACKS)[0]?.required).toBe(true);
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
