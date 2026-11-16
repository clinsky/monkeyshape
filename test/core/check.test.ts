/** Checks run on in-memory Snapshots (`repo` in test/support.ts), never a temp repo: D-pure-checks. */
import { describe, expect, test } from "bun:test";
import { notices, prerequisites, runChecks, unevaluated } from "../../src/core/check.ts";
import { applyBaseline, count, tighten } from "../../src/core/ratchet.ts";
import { resolveConfig, type ShapeConfig } from "../../src/schemas/config.ts";
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
      unevaluated(config(shape), snapshot, ["refs"], Object.keys(baseline)),
    );
    expect(result).toEqual({ failing: [], loose: [], grandfathered: 1 });
  });

  test("a regression in a selected check still fails", () => {
    const baseline = count(runChecks(config(shape), repo(files, tools)));
    const worse = repo({ ...files, "AGENTS.md": "`src/gone.ts` `src/also-gone.ts`" }, tools);
    const result = applyBaseline(
      runChecks(config(shape), worse, ["refs"]),
      baseline,
      unevaluated(config(shape), worse, ["refs"], Object.keys(baseline)),
    );
    expect(result.failing.length).toBe(2);
  });
});

describe("a check that didn't run", () => {
  test("a check turned off keeps its baseline entries through --tighten", () => {
    const off = config({
      ...shape,
      checks: { rules: { off: "paused while the parser is replaced" } },
    });
    const snapshot = repo(files, tools);
    const baseline = { "rules/no-throw": { "src/core/a.ts": 2 } };
    // As `mshape baseline --tighten` calls it: no baseline rules passed.
    expect(tighten(baseline, runChecks(off, snapshot), unevaluated(off, snapshot))).toEqual(
      baseline,
    );
  });
});

describe("integrations", () => {
  test("bd unavailable: its rules are unevaluated and the run says so", () => {
    const snapshot = repo(
      {},
      { beads: { state: "unavailable", reason: "bd is not on PATH" }, typechecked: [], linted: [] },
    );
    expect([...unevaluated(config(), snapshot)]).toEqual([
      "refs/bead-in-code",
      "budgets/memories-count",
      "budgets/memories-bytes",
      "beads/unowned",
      "beads/deferred-in-track",
      "beads/todo-closed",
      "beads/export-unreadable",
    ]);
    expect(notices(config(), snapshot)[0]).toContain("bd is not on PATH");
  });

  test("bd failing is a prerequisite failure, not a skip", () => {
    const snapshot = repo(
      { "AGENTS.md": "" },
      { beads: { state: "failed", reason: "exit 1" }, typechecked: [], linted: [] },
    );
    expect(prerequisites(config(), snapshot).map((v) => v.rule)).toEqual([
      "prerequisites/beads-failed",
    ]);
  });

  test("prerequisite failures never reach the checks a baseline can count", () => {
    const snapshot = repo(
      { "AGENTS.md": "" },
      { beads: { state: "failed", reason: "exit 1" }, typechecked: [], linted: [] },
    );
    const counted = runChecks(config(), snapshot).map((v) => v.rule);
    expect(counted.filter((rule) => rule.startsWith("prerequisites/"))).toEqual([]);
  });

  test("beads: required fails closed when bd can't answer", () => {
    const required = config({ beads: "required" });
    const missing = repo(
      { "AGENTS.md": "" },
      { beads: { state: "unavailable", reason: "bd is not on PATH" }, typechecked: [], linted: [] },
    );
    expect(prerequisites(required, missing).map((v) => v.rule)).toEqual([
      "prerequisites/beads-required",
    ]);
    expect(notices(required, missing)).toEqual([]);
    const absent = repo({ "AGENTS.md": "" }, { typechecked: [], linted: [] });
    expect(prerequisites(required, absent).map((v) => v.rule)).toEqual([
      "prerequisites/beads-required",
    ]);
    expect(prerequisites(config(), absent)).toEqual([]);
  });

  test("tools that ran leave nothing to say", () => {
    expect(notices(config(), repo({}, { typechecked: [], linted: [], memories: {} }))).toEqual([]);
  });
});

describe("a --config run", () => {
  test("every finding about the config names the file loaded, not the repo's shape.config.ts", () => {
    const trial = resolveConfig(
      {
        sources: { include: ["src/**/*.ts", { path: "gone/**", optional: false }] },
        coverage: {
          commands: [{ files: ["native/**"], run: ["true"] }],
          exemptFiles: [{ path: "nowhere.py", reason: "a reason a later agent can weigh" }],
        },
        files: { large: [{ path: "data/big.bin", reason: "a reason a later agent can weigh" }] },
      },
      "../trial/shape.config.ts",
    );
    const found = runChecks(trial, repo({ "src/a.ts": "export const a = 1;\n" }), [
      "arch",
      "sources",
      "coverage",
      "files",
    ]);
    const aboutConfig = found.filter((v) => v.file.endsWith("shape.config.ts"));
    expect(aboutConfig.map((v) => v.rule).sort()).toEqual([
      "arch/no-module-map",
      "coverage/command-unmatched",
      "coverage/exempt-unmatched",
      "files/large-unmatched",
      "sources/unmatched",
    ]);
    expect(new Set(aboutConfig.map((v) => v.file))).toEqual(new Set(["../trial/shape.config.ts"]));
  });
});
