/** The plan's pack table, row by row: how the core treats files by the packs that claim them. */
import { describe, expect, test } from "bun:test";
import { checkArch } from "../../src/core/arch.ts";
import { evaluate, prerequisites, ruleIds } from "../../src/core/check.ts";
import { checkCoverage } from "../../src/core/coverage.ts";
import { checkPacks } from "../../src/core/packs.ts";
import { checkSources } from "../../src/core/sources.ts";
import type { Integration, LoadedPack, Pack } from "../../src/packs/pack.ts";
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

describe("arch over a graph its pack builds from a tool", () => {
  // A Rust-like pack: its loader runs for arch, and its graph reads the tool's output.
  const graphed: Pack = {
    ...fakePack("rust", "Rust", "rs"),
    tools: [{ name: "rustc", rule: "compile", uncovered: () => "is not in a crate" }],
    loadFor: ["arch", "coverage"],
  };
  const shape = config({
    packs: ["rust"],
    sources: { include: ["**/*.rs"] },
    arch: { modules: { api: { description: "api", paths: ["api"] } } },
  });
  const loaded = (integration: Integration): LoadedPack => ({
    pack: graphed,
    load: { tools: [{ tool: "rustc", integration, files: undefined }], outputs: new Map() },
  });

  test("the tool failed: arch is unavailable naming it, never passed over no edges", () => {
    const failed = repo(
      { "api/src/lib.rs": "" },
      {
        packs: [
          loaded({
            state: "failed",
            reason: "`cargo metadata` exited 101: failed to load manifest",
          }),
        ],
      },
    );
    expect(evaluate(shape, failed, ["arch"]).reports[0]?.outcome).toEqual({
      state: "unavailable",
      prerequisite: "rustc",
      reason: "`cargo metadata` exited 101: failed to load manifest",
      required: true,
    });
  });

  test("the tool ran: arch runs; and a pack whose graph needs no tool never waits on one", () => {
    const ran = repo({ "api/src/lib.rs": "" }, { packs: [loaded({ state: "ok" })] });
    expect(evaluate(shape, ran, ["arch"]).reports[0]?.outcome.state).toBe("passed");
    // TypeScript's graph is its own reading of the files: tsc failing doesn't block arch.
    const ts = repo({ "src/core/a.ts": "" }, { tsc: { state: "failed", reason: "tsc crashed" } });
    expect(evaluate(config(), ts, ["arch"]).reports[0]?.outcome.state).not.toBe("unavailable");
  });
});

describe("the packs check", () => {
  test("a pack's own findings, as packs/<id>/<kind>; none where no pack has checks", () => {
    const linting: Pack = {
      ...python,
      findingKinds: ["no-extend"],
      findings: ({ repo: view }) =>
        view.files.includes("ruff.toml")
          ? [{ kind: "no-extend", file: "ruff.toml", line: 1, message: "add extend" }]
          : [],
    };
    const snapshot = repo({ "ruff.toml": "", "app/b.py": "" }, { packs: [listed(linting)] });
    expect(checkPacks(twoPacks, snapshot)).toEqual([
      {
        check: "packs",
        rule: "packs/python/no-extend",
        file: "ruff.toml",
        line: 1,
        message: "add extend",
      },
    ]);
    expect(ruleIds([], [linting])).toEqual([...ruleIds([], []), "packs/python/no-extend"]);
    const { reports } = evaluate(config(), repo({ "src/a.ts": "" }), ["packs"]);
    expect(reports[0]?.outcome).toEqual({
      state: "not-applicable",
      reason: "typescript has no checks of its own",
    });
  });
});

test("a tool unavailable for want of something else says that fix, not the tool's install", () => {
  const missing = (fix?: string) =>
    prerequisites(
      config(),
      repo(
        { "src/a.ts": "" },
        {
          tsc: {
            state: "unavailable",
            reason: "bun is not on PATH",
            ...(fix === undefined ? {} : { fix }),
          },
          linted: [],
        },
      ),
      ["coverage"],
    ).map((v) => v.message);
  expect(missing()).toEqual([expect.stringContaining("Install it (`bun add -d typescript`")]);
  expect(missing("Install Bun: https://bun.sh.")).toEqual([
    "coverage needs tsc, but bun is not on PATH. Install Bun: https://bun.sh.",
  ]);
});

test("a kind a pack didn't declare fails as packs/undeclared-kind, naming the pack and kind", () => {
  const sloppy: Pack = {
    ...python,
    findingKinds: ["declared"],
    findings: () => [{ kind: "undeclared", file: "app/b.py", line: 2, message: "the finding" }],
  };
  const found = checkPacks(twoPacks, repo({ "app/b.py": "" }, { packs: [listed(sloppy)] }));
  expect(found.map((v) => `${v.rule} ${v.file}:${v.line}`)).toEqual([
    "packs/undeclared-kind app/b.py:2",
  ]);
  expect(found[0]?.message).toStartWith("the python pack reported `undeclared`, a kind missing");
  expect(found[0]?.message).toEndWith("Its finding was: the finding");
});

describe("the install hint for a missing tool", () => {
  const missing = (
    input: Parameters<typeof config>[0],
    file: string,
    packs?: Parameters<typeof repo>[1],
  ) =>
    prerequisites(
      { ...config(input), configFile: file },
      repo({ "src/a.ts": "", "crates/a.rs": "" }, packs ?? { linted: [] }),
      ["coverage"],
    ).map((v) => v.message);

  test("a config that can make it optional says how, in its own syntax and file", () => {
    expect(missing({}, "shape.config.ts")[0]).toContain(
      'or set `prerequisites: { tsc: "optional" }` in shape.config.ts to read its config instead',
    );
    expect(missing({}, "shape.toml")[0]).toContain(
      'or set `tsc = "optional"` under `[prerequisites]` in shape.toml to read its config instead',
    );
  });

  test("a tool coverage can't read the config of, or the config can't name, says only to install it", () => {
    const rust: Pack = {
      ...fakePack("rust", "Rust", "rs"),
      tools: [{ name: "rustc", rule: "compile", uncovered: () => "is in no mod tree" }],
      prerequisites: [{ name: "rustc", required: true, install: "`rustup default stable`" }],
    };
    const found = missing({ sources: { include: ["crates/**"] } }, "shape.toml", {
      packs: [{ pack: rust, load: { tools: [], outputs: new Map() } }],
    });
    expect(found).toEqual([
      "coverage needs rustc, but its pack's loader didn't run it. Install it (`rustup default stable`).",
    ]);
  });
});
