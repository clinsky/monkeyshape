import { describe, expect, test } from "bun:test";
import { notices, prerequisites, runChecks, unevaluated } from "../../src/core/check.ts";
import { applyBaseline, count } from "../../src/core/ratchet.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, repo } from "../support.ts";

const shape: ShapeConfig = {
  arch: { modules: { core: { description: "logic" } } },
  sources: { include: ["src/**/*.ts"], exclude: [] },
};

const files = {
  "AGENTS.md": "# Agents\nSee `src/gone.ts`.\n",
  "src/core/a.ts": "throw x;\nthrow y;\n",
};
/** Both tools "ran" and saw the one source file, so coverage has nothing to say. */
const tools = { typechecked: ["src/core/a.ts"], linted: ["src/core/a.ts"] };

describe("check --only with a baseline", () => {
  test("baseline entries for unselected checks are neither loose nor failing", () => {
    const snapshot = repo(files, tools);
    const all = runChecks(config(shape), snapshot);
    const baseline = count(all);
    expect(Object.keys(baseline).sort()).toEqual(["refs/missing-path", "rules/no-throw"]);

    const refsOnly = runChecks(config(shape), snapshot, ["refs"]);
    const result = applyBaseline(
      refsOnly,
      baseline,
      unevaluated(snapshot, ["refs"], Object.keys(baseline)),
    );
    expect(result).toEqual({ failing: [], loose: [], grandfathered: 1 });
  });

  test("a regression in a selected check still fails", () => {
    const baseline = count(runChecks(config(shape), repo(files, tools)));
    const worse = repo({ ...files, "AGENTS.md": "`src/gone.ts` `src/also-gone.ts`" }, tools);
    const result = applyBaseline(
      runChecks(config(shape), worse, ["refs"]),
      baseline,
      unevaluated(worse, ["refs"], Object.keys(baseline)),
    );
    expect(result.failing.length).toBe(2);
  });
});

describe("integrations", () => {
  test("bd unavailable: its rules are unevaluated and the run says so", () => {
    const snapshot = repo({}, { beads: { state: "unavailable", reason: "bd is not on PATH" } });
    expect([...unevaluated(snapshot)]).toEqual([
      "refs/bead-in-code",
      "budgets/memories-count",
      "budgets/memories-bytes",
    ]);
    expect(notices(config(), snapshot)[0]).toContain("bd is not on PATH");
  });

  test("bd failing is a prerequisite failure, not a skip", () => {
    const snapshot = repo({ "AGENTS.md": "" }, { beads: { state: "failed", reason: "exit 1" } });
    expect(prerequisites(config(), snapshot).map((v) => v.rule)).toEqual([
      "prerequisites/beads-failed",
    ]);
  });

  test("prerequisite failures never reach the checks a baseline can count", () => {
    const snapshot = repo({ "AGENTS.md": "" }, { beads: { state: "failed", reason: "exit 1" } });
    const counted = runChecks(config(), snapshot).map((v) => v.rule);
    expect(counted.filter((rule) => rule.startsWith("prerequisites/"))).toEqual([]);
  });

  test("beads: required fails closed when bd can't answer", () => {
    const required = config({ beads: "required" });
    const missing = repo(
      { "AGENTS.md": "" },
      { beads: { state: "unavailable", reason: "bd is not on PATH" } },
    );
    expect(prerequisites(required, missing).map((v) => v.rule)).toEqual([
      "prerequisites/beads-required",
    ]);
    expect(notices(required, missing)).toEqual([
      "coverage approximated tsc's file list from its config (not run in unit tests): inheritance and project references are not resolved",
      "coverage approximated biome's file list from its config (not run in unit tests): inheritance and project references are not resolved",
    ]);
    const absent = repo({ "AGENTS.md": "" });
    expect(prerequisites(required, absent).map((v) => v.rule)).toEqual([
      "prerequisites/beads-required",
    ]);
    expect(prerequisites(config(), absent)).toEqual([]);
  });

  test("tools that ran leave nothing to say", () => {
    expect(notices(config(), repo({}, { typechecked: [], linted: [], memories: {} }))).toEqual([]);
  });
});
