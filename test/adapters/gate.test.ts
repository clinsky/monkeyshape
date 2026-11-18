import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { type GateRun, runGate } from "../../src/adapters/gate.ts";
import {
  type GateStage,
  type PackId,
  type ResolvedConfig,
  resolveConfig,
} from "../../src/schemas/config.ts";

let dir = "";
let empty = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-gate-"));
  // A PATH with nothing on it: a pack's program is missing whatever this machine has.
  empty = await mkdtemp(join(tmpdir(), "mshape-gate-path-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(empty, { recursive: true, force: true });
});

/** A config with these packs and repo stages; `packs = []` leaves only `mshape check` and the repo's. */
const config = (
  packs: ReadonlyArray<PackId>,
  stages: ReadonlyArray<GateStage>,
  prerequisites: ResolvedConfig["prerequisites"] = { tsc: "required", biome: "required" },
): ResolvedConfig => ({
  ...resolveConfig({ gate: { stages } }, "shape.toml"),
  packs,
  prerequisites,
});

const passing: Effect.Effect<GateRun> = Effect.succeed({ output: "mshape check passed", code: 0 });

const gate = (
  value: ResolvedConfig,
  options: { fast?: boolean; check?: Effect.Effect<GateRun>; path?: string } = {},
) =>
  Effect.runPromise(
    runGate(dir, value, {
      fast: options.fast ?? false,
      check: options.check ?? passing,
      ...(options.path === undefined ? {} : { path: options.path }),
    }),
  );

/** `sh -c <script>` as a stage's argv. */
const sh = (name: string, script: string, more: Partial<GateStage> = {}): GateStage => ({
  name,
  run: ["sh", "-c", script],
  ...more,
});

/** The stage lines: `name state`, without the detail. */
const states = (output: string) =>
  output
    .split("\n")
    .filter((line) => line.startsWith("  "))
    .map((line) => line.trim().split(/\s+/).slice(0, 2).join(" "));

/** The plan's gate table, the rows about running. */
describe("runGate", () => {
  test("every stage passes: exit 0, one line each, the summary last", async () => {
    const ran = await gate(config([], [sh("one", "echo hi", { fast: true }), sh("two", "true")]));
    expect(ran.code).toBe(0);
    expect(states(ran.output)).toEqual(["mshape-check passed", "one passed", "two passed"]);
    expect(ran.output.split("\n").at(-1)).toBe("mshape gate passed");
  });

  test("a fast stage fails: the rest still run; exit 1; its whole output kept in a log", async () => {
    const ran = await gate(
      config(
        [],
        [
          sh("lint", "for i in $(seq 0 99); do echo line $i; done; exit 3", { fast: true }),
          sh("after", "echo still ran > after.txt"),
        ],
      ),
    );
    expect(ran.code).toBe(1);
    expect(states(ran.output)).toEqual(["mshape-check passed", "lint failed", "after passed"]);
    expect(await Bun.file(join(dir, "after.txt")).text()).toBe("still ran\n");
    // The tail inline, the whole in the log it names.
    expect(ran.output).toContain("line 99");
    expect(ran.output).not.toContain("line 10\n");
    const log = /\(the whole output: (.+)\)/.exec(ran.output)?.[1] ?? "";
    expect(await Bun.file(log).text()).toContain("line 0\n");
    expect(ran.output).toMatch(/^ {2}lint +failed +sh -c .*\(exit 3\)$/m);
    expect(ran.output).toContain("(exit 3)");
    expect(ran.output.split("\n").at(-1)).toBe("mshape gate failed: lint");
  });

  test("mshape check failing fails the gate, like any stage", async () => {
    const ran = await gate(config([], []), {
      check: Effect.succeed({ output: "mshape check failed: 1 problem", code: 1 }),
    });
    expect(ran.code).toBe(1);
    expect(ran.output).toContain("mshape check failed: 1 problem");
  });

  test("--fast: the full phase's stages are listed as skipped, not run", async () => {
    const ran = await gate(config([], [sh("slow", "echo ran > slow.txt")]), { fast: true });
    expect(ran.code).toBe(0);
    expect(states(ran.output)).toEqual(["mshape-check passed", "slow skipped"]);
    expect(await Bun.file(join(dir, "slow.txt")).exists()).toBe(false);
    expect(ran.output.split("\n").at(-1)).toBe("mshape gate --fast passed");
  });

  test("a pack stage's program missing: fails if its pack requires it, a note if optional", async () => {
    const required = await gate(config(["rust"], []), { fast: true, path: empty });
    expect(required.code).toBe(1);
    expect(required.output).toContain(
      "`cargo` isn't installed here (not in node_modules/.bin or on the PATH): the rust pack requires it",
    );
    const optional = await gate(
      config(["typescript"], [], { tsc: "optional", biome: "optional" }),
      { fast: true, path: empty },
    );
    expect(states(optional.output)).toEqual([
      "tsc note",
      "biome note",
      "mshape-check passed",
      "bun-test skipped",
    ]);
    expect(optional.output).toContain("`prerequisites` makes it optional");
    expect(optional.code).toBe(0);
  });

  test("a repo stage's program missing: fails, naming it", async () => {
    const ran = await gate(config([], [{ name: "spell", run: ["no-such-typos-x"] }]), {
      path: empty,
    });
    expect(ran.code).toBe(1);
    expect(ran.output).toContain(
      "`no-such-typos-x` isn't installed here (not in node_modules/.bin or on the PATH), and this repo's gate stage `spell` needs it",
    );
  });

  test("a stage that exits with a code in its ok-exit passes", async () => {
    const ran = await gate(config([], [sh("pytest", "exit 5", { okExit: [0, 5] })]));
    expect(states(ran.output)).toContain("pytest passed");
    expect(ran.code).toBe(0);
    const strict = await gate(config([], [sh("pytest", "exit 5")]));
    expect(strict.code).toBe(1);
  });

  test("colour codes are gone from what is shown and kept", async () => {
    const ran = await gate(
      config([], [sh("red", "printf '\\033[31mred text\\033[0m\\n'; exit 1")]),
    );
    expect(ran.output).toContain("red text");
    expect(ran.output).not.toContain("\u001b[");
  });
});
