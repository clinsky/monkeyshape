/** The plan's pack table, row by row: how the core treats files by the packs that claim them. */
import { describe, expect, test } from "bun:test";
import { checkArch } from "../../src/core/arch.ts";
import { evaluate } from "../../src/core/check.ts";
import { checkCoverage } from "../../src/core/coverage.ts";
import { checkSources } from "../../src/core/sources.ts";
import type { Pack } from "../../src/packs/pack.ts";
import { typescript } from "../../src/packs/typescript/index.ts";
import { config, fakePack, listed, repo } from "../support.ts";

const python = fakePack("python", "Python", "py");
const both = { packs: [listed(typescript), listed(python)] };
const twoPacks = config({
  packs: ["typescript", "python"],
  sources: {
    include: [
      { path: "src/**/*.ts", optional: true },
      { path: "app/**/*.py", optional: true },
    ],
  },
  arch: {
    root: ".",
    modules: {
      "src/core": { description: "ts logic", pack: "typescript" },
      app: { description: "py app", pack: "python" },
    },
  },
});

describe("the pack table", () => {
  test("a file one listed pack claims: that pack's checks see it", () => {
    const found = checkSources(twoPacks, repo({ "src/core/a.ts": "", "app/b.py": "" }, both));
    expect(found).toEqual([]);
    const outside = checkSources(twoPacks, repo({ "lib/c.py": "" }, both));
    expect(outside.map((v) => `${v.rule} ${v.file}`)).toEqual(["sources/outside lib/c.py"]);
    expect(outside[0]?.message).toStartWith("is Python outside `sources`");
  });

  test("a file two listed packs claim fails, naming both", () => {
    const greedy = fakePack("python", "Python", "ts");
    const found = checkSources(
      twoPacks,
      repo({ "src/core/a.ts": "" }, { packs: [listed(typescript), listed(greedy)] }),
    );
    expect(found.map((v) => v.rule)).toEqual(["sources/claimed-twice"]);
    expect(found[0]?.message).toContain("`typescript` and `python`");
  });

  test("a file no listed pack claims: only the neutral checks read it", () => {
    const snapshot = repo({ "src/core/a.ts": "", "notes.txt": "// TODO see plan/x.md" }, both);
    const { violations } = evaluate(twoPacks, snapshot, ["arch", "sources", "refs", "coverage"]);
    expect(violations.filter((v) => v.file === "notes.txt")).toEqual([]);
  });

  test("a claimed file of a pack not listed: sources names the pack to list", () => {
    const found = checkSources(
      config(),
      repo({ "src/a.ts": "", "tools/gen.py": "" }, { otherPacks: [python] }),
    );
    expect(found.map((v) => `${v.rule} ${v.file}`)).toEqual(["sources/unlisted-pack tools/gen.py"]);
    expect(found[0]?.message).toContain('Add `"python"` to `packs`');
    // Nor is it held to a declared command: a listed pack's tools cover it instead.
    const covered = checkCoverage(
      twoPacks,
      repo({ "app/b.py": "", "tsconfig.json": "{}", "biome.json": "{}" }, both),
    );
    expect(covered.filter((v) => v.rule === "coverage/uncovered")).toEqual([]);
  });

  test("an import between modules of different packs is not an edge: graphs are per pack", () => {
    // Each pack's graph names a file of the other: arch drops both edges.
    const pyEdges: Pack = {
      ...python,
      graph: ({ files }) => ({
        edges: files.map((from) => ({ from, written: "core", to: "src/core/a.ts" })),
        hostUses: [],
      }),
    };
    const found = checkArch(
      twoPacks,
      repo(
        { "src/core/a.ts": 'import "../../app/b.py";\n', "app/b.py": "import core\n" },
        { packs: [listed(typescript), listed(pyEdges)] },
      ),
    );
    // Neither direction is judged, though neither module may import the other.
    expect(found).toEqual([]);
  });

  test("a required prerequisite missing fails the check that needs it", () => {
    const { reports } = evaluate(config(), repo({ "src/a.ts": "" }), ["coverage"]);
    expect(reports[0]?.outcome).toMatchObject({
      state: "unavailable",
      prerequisite: "tsc",
      required: true,
    });
  });

  test("two packs listed: both run, and their findings merge", () => {
    const pyTool: Pack = {
      ...python,
      tools: [{ name: "ty", rule: "typecheck", uncovered: () => "is not in ty's project" }],
    };
    const snapshot = repo(
      { "src/core/a.ts": "", "app/b.py": "", "tsconfig.json": "{}", "biome.json": "{}" },
      {
        packs: [
          {
            pack: typescript,
            load: {
              tools: [
                { tool: "tsc", integration: { state: "ok" }, files: new Set() },
                { tool: "biome", integration: { state: "ok" }, files: new Set(["src/core/a.ts"]) },
              ],
              outputs: new Map(),
            },
          },
          {
            pack: pyTool,
            load: {
              tools: [{ tool: "ty", integration: { state: "ok" }, files: new Set() }],
              outputs: new Map(),
            },
          },
        ],
      },
    );
    expect(checkCoverage(twoPacks, snapshot).map((v) => `${v.rule} ${v.file}`)).toEqual([
      "coverage/typecheck src/core/a.ts",
      "coverage/typecheck app/b.py",
    ]);
  });
});

test("a file in sources no listed pack reads fails sources, and rules doesn't count it", () => {
  // The review's probe: JavaScript in the rules' scope, covered by the repo's own command.
  const jsToo = config({
    sources: { include: ["src/**/*.ts", "src/**/*.js"] },
    coverage: { commands: [{ files: ["src/**/*.js"], run: ["eslint", "{files}"] }] },
  });
  const snapshot = repo({
    "src/a.ts": "",
    "src/b.js": 'export const g = () => { throw new Error("x"); };\n',
  });
  const { reports } = evaluate(jsToo, snapshot, ["sources", "rules"]);
  expect(reports.map((r) => [r.check, r.outcome.state, r.violations.map((v) => v.rule)])).toEqual([
    ["sources", "failed", ["sources/unclaimed"]],
    ["rules", "passed", []],
  ]);
  expect(reports[1]?.outcome).toEqual({ state: "passed", examined: "1 file in sources" });
  expect(reports[0]?.violations[0]?.message).toContain("'src/**/*.{ts,tsx}'");
});
