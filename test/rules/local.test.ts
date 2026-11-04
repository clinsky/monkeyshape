import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, defineRule, type Node, walk } from "../../src/api/monkeyshape.ts";
import { checkRules, localRuleHatches } from "../../src/core/rules/engine.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { run as spawn } from "../integration/harness.ts";
import { config, repo } from "../support.ts";

/** Bans `save(...)` everywhere: the example shape of an enforcement-point rule. */
const noSave = defineRule({
  id: "no-save",
  bugClass: "Writes that skip the merge, replacing what earlier runs recorded.",
  message: "calls save directly; write through saveMerged, which merges the prior records.",
  check: (file) => {
    const found: Array<{ offset: number }> = [];
    walk(file.program, {
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "save")
          found.push({ offset: node.start });
      },
    });
    return found;
  },
  cases: {
    fail: ["save(records);\n"],
    pass: ["saveMerged(prior, records);\n", "store.save(records);\n"],
  },
});

const all = (files: Record<string, string>, input: ShapeConfig = {}) =>
  checkRules(config({ localRules: [noSave], ...input }), repo(files), []).map(
    (v) => `${v.rule} ${v.file}:${v.line} ${v.message}`,
  );

/** Without `rules/local-cases`: rules built from noSave inherit cases written for it. */
const run = (files: Record<string, string>, input: ShapeConfig = {}) =>
  all(files, input).filter((line) => !line.startsWith("rules/local-cases "));

const ids = (files: Record<string, string>, input: ShapeConfig = {}) =>
  run(files, input).map((line) => line.slice(0, line.indexOf(" ", line.indexOf(" ") + 1)));

describe("local rules", () => {
  test("a local rule runs as local/<id> over the sources, with its message", () => {
    expect(
      run({ "src/a.ts": "saveMerged(x);\nsave(x);\n", "src/a.test.ts": "save(x);\n" }),
    ).toEqual([
      "rules/local/no-save src/a.ts:2 calls save directly; write through saveMerged, which merges the prior records.",
    ]);
  });

  test("the engine's escape hatches apply to it under local/<id>", () => {
    const source = "// shape-ignore local/no-save: the merge function itself\nsave(x);\n";
    expect(ids({ "src/a.ts": source })).toEqual([]);
    expect(
      ids(
        { "src/merge.ts": "save(x);\n", "src/a.ts": "save(y);\n" },
        { rules: { "local/no-save": { allow: [{ path: "src/merge.ts", reason: "the merge" }] } } },
      ),
    ).toEqual(["rules/local/no-save src/a.ts:1"]);
    expect(
      ids({ "src/a.ts": "save(x);\n" }, { rules: { "local/no-save": { off: "retired for now" } } }),
    ).toEqual([]);
    expect(
      ids({ "src/a.ts": "// shape-ignore local/no-save: nothing to suppress\nconst x = 1;\n" }),
    ).toEqual(["rules/unused-ignore src/a.ts:1"]);
  });

  test("a misshaped or repeated entry fails, saying what to export; the valid ones still run", () => {
    const entries: ReadonlyArray<unknown> = [
      noSave,
      "rules/noSave.ts",
      { ...noSave, id: "No Save" },
      { ...noSave, id: "short", message: "no" },
      { ...noSave, id: "no-check", check: undefined },
      noSave,
    ];
    const lines = run({ "src/a.ts": "save(x);\n" }, { localRules: entries });
    expect(lines.filter((line) => line.startsWith("rules/local-rule"))).toEqual([
      expect.stringContaining(
        "shape.config.ts:1 localRules[1] is string, not a rule (a path: import the module",
      ),
      expect.stringContaining('localRules[2] its id "No Save" is not lowercase words'),
      expect.stringContaining("localRules[3] 'short' needs a `message` of at least 8"),
      expect.stringContaining("localRules[4] 'no-check' needs a `check` function"),
      expect.stringContaining("localRules[5] repeats the id 'no-save'"),
    ]);
    expect(lines).toContain(
      "rules/local/no-save src/a.ts:1 calls save directly; write through saveMerged, which merges the prior records.",
    );
  });

  test("a rule that throws or returns a bad offset fails as local-rule, and no allowance hides it", () => {
    const throws = defineRule({ ...noSave, id: "throws", check: () => [JSON.parse("{")] });
    const badOffset = defineRule({ ...noSave, id: "bad-offset", check: () => [{ offset: 999 }] });
    const bigint = { ...noSave, id: "bigint", check: () => [{ offset: 1n }] };
    const notList = { ...noSave, id: "not-list", check: () => 3 };
    const allow = { allow: [{ path: "src/**", reason: "everything allowed" }] };
    const lines = run(
      { "src/a.ts": "const x = 1;\n" },
      {
        localRules: [throws, badOffset, bigint, notList],
        rules: Object.fromEntries(
          ["throws", "bad-offset", "bigint", "not-list"].map((id) => [`local/${id}`, allow]),
        ),
      },
    );
    expect(lines.filter((line) => line.startsWith("rules/local-rule"))).toEqual([
      expect.stringContaining("src/a.ts:1 the rule local/throws broke on this file: it threw"),
      expect.stringContaining(
        'the rule local/bad-offset broke on this file: it returned {"offset":999} in its list',
      ),
      expect.stringContaining("local/bigint broke on this file: it returned [object Object]"),
      expect.stringContaining("local/not-list broke on this file: it returned 3, not a list"),
    ]);
  });

  test("a rule may return bare offsets, or a message for one finding", () => {
    const mixed = defineRule({
      ...noSave,
      id: "mixed",
      check: (file) => [file.text.indexOf("b"), { offset: 0, message: "this one, specifically" }],
    });
    expect(run({ "src/a.ts": "a;\nb;\n" }, { localRules: [mixed] })).toEqual([
      "rules/local/mixed src/a.ts:2 calls save directly; write through saveMerged, which merges the prior records.",
      "rules/local/mixed src/a.ts:1 this one, specifically",
    ]);
  });

  test("walk calls each handler with a typed node, parents before children", () => {
    const seen: Array<string> = [];
    const rule = defineRule({
      ...noSave,
      id: "order",
      check: (file) => {
        if (file.path !== "src/a.ts") return [];
        walk(file.program, {
          CallExpression: (node) => seen.push(`call ${file.text.slice(node.start, node.end)}`),
          Identifier: (node: Node & { type: "Identifier" }) => seen.push(`id ${node.name}`),
        });
        return [];
      },
    });
    checkRules(config({ localRules: [rule] }), repo({ "src/a.ts": "f(g());\n" }), []);
    expect(seen).toEqual(["call f(g())", "id f", "call g()", "id g"]);
  });

  test("a rule that breaks leaves its escape hatches alone, and says so once, with where it threw", () => {
    const throwsOnB = defineRule({
      ...noSave,
      id: "throws-on-b",
      check: (file) => {
        if (file.path !== "src/a.ts") throw new TypeError("boom");
        return [];
      },
    });
    const lines = run(
      {
        "src/a.ts": "save(x);\n",
        "src/b.ts": "// shape-ignore local/throws-on-b: generated, reviewed\nsave(x);\n",
        "src/c.ts": "save(x);\n",
      },
      {
        localRules: [throwsOnB],
        rules: { "local/throws-on-b": { allow: [{ path: "src/c.ts", reason: "the merge" }] } },
      },
    );
    expect(lines).toEqual([
      expect.stringMatching(
        /^rules\/local-rule src\/b\.ts:1 the rule local\/throws-on-b broke on 2 files, this one first: it threw TypeError: boom at \/.*\/test\/rules\/local\.test\.ts:\d+:\d+\. Fix/,
      ),
    ]);
  });

  test("a misshaped entry's own config is not reported as unknown or unused", () => {
    const misshaped = { ...noSave, id: "cfg", check: undefined };
    const lines = run(
      { "src/a.ts": "" },
      {
        localRules: [misshaped],
        rules: {
          "local/cfg": { allow: [{ path: "src/a.ts", reason: "the merge function" }] },
        },
      },
    );
    expect(lines).toEqual([
      expect.stringContaining(
        "rules/local-rule shape.config.ts:1 localRules[0] 'cfg' needs a `check`",
      ),
    ]);
  });

  test("an async check, or a module namespace as an entry, is told what it got wrong", async () => {
    const asyncCheck = {
      ...noSave,
      id: "async",
      check: async () => Promise.reject(new Error("late")),
    };
    const lines = run({ "src/a.ts": "" }, { localRules: [asyncCheck, { default: noSave }] });
    expect(lines).toEqual([
      expect.stringContaining(
        "localRules[1] is a module namespace, not a rule (a module namespace, as `import * as`: list its default export",
      ),
      expect.stringContaining(
        "local/async broke on this file: `check` returned a Promise: it must be synchronous",
      ),
    ]);
    // Its rejection was handled: an unhandled one would fail this test.
    await Bun.sleep(1);
  });

  test("tsc rejects a path, a namespace or an async check where a rule goes", () => {
    defineConfig({ localRules: [noSave] });
    // @ts-expect-error a path is not a rule: import the module
    defineConfig({ localRules: ["./rules/noSave.ts"] });
    // @ts-expect-error a module namespace is not a rule: list its default export
    defineConfig({ localRules: [{ default: noSave }] });
    // @ts-expect-error check must be synchronous
    defineRule({ ...noSave, check: async () => [0] });
  });
});

describe("a local rule's cases", () => {
  const cases = (rule: unknown, input: ShapeConfig = {}) =>
    all({}, { localRules: [rule], ...input }).filter((line) =>
      line.startsWith("rules/local-cases "),
    );

  test("cases that hold are silent, and a turned-off rule's cases don't run", () => {
    expect(cases(noSave)).toEqual([]);
    expect(
      cases(
        { ...noSave, cases: { fail: ["x;"], pass: [] } },
        { rules: { "local/no-save": { off: "retired for now" } } },
      ),
    ).toEqual([]);
  });

  test("a rule missing its must-pass or must-fail case fails the gate, saying why each is needed", () => {
    expect(cases({ ...noSave, cases: { fail: ["save(x);"], pass: [] } })).toEqual([
      expect.stringContaining(
        "shape.config.ts:1 local/no-save has no must-pass case: add `cases.pass`, valid code close to the bug, so a rule that fires on valid code fails here",
      ),
    ]);
    expect(cases({ ...noSave, cases: { pass: ["saveMerged(x);"] } })).toEqual([
      expect.stringContaining("local/no-save has no must-fail case: add `cases.fail`"),
    ]);
    expect(cases({ ...noSave, cases: undefined })).toEqual([
      expect.stringContaining(
        "local/no-save has no `cases`: give it `cases: { fail: [...], pass: [...] }`",
      ),
    ]);
  });

  test("a must-fail case it misses, or a must-pass or allowed case it fires on, fails the gate", () => {
    const wrong = {
      ...noSave,
      cases: {
        fail: ["saveMerged(x);", "save(x);"],
        pass: ["ok();\nsave(x);\n"],
        allowed: [{ path: "src/merge.ts", source: "save(x);" }, 3],
      },
    };
    expect(cases(wrong)).toEqual([
      expect.stringContaining(
        "local/no-save's must-fail case 1 reported nothing: the rule no longer catches the bug",
      ),
      expect.stringContaining(
        "local/no-save's must-pass case 1 was reported at line 2: the rule fires on code it must accept",
      ),
      expect.stringContaining("local/no-save's allowed-exception case 1 was reported at line 1"),
      expect.stringContaining(
        "local/no-save's allowed-exception case 2 is neither source text nor `{ path, source }`",
      ),
    ]);
  });

  test("a case that doesn't parse is reported as broken, not run, whatever its kind", () => {
    expect(
      cases({
        ...noSave,
        cases: { fail: ["save(x"], pass: ["save(x;", "this is { not code"], allowed: ["a b"] },
      }),
    ).toEqual([
      expect.stringContaining(
        "local/no-save's must-fail case 1 doesn't parse: Expected `)` but found `EOF`; a case must be valid source",
      ),
      expect.stringContaining("local/no-save's must-pass case 1 doesn't parse:"),
      expect.stringContaining("local/no-save's must-pass case 2 doesn't parse:"),
      expect.stringContaining("local/no-save's allowed-exception case 1 doesn't parse:"),
    ]);
  });

  test("an allowed case at a path the config allows reports nothing, as in a real run", () => {
    const rule = {
      ...noSave,
      cases: { ...noSave.cases, allowed: [{ path: "src/store.ts", source: "save(x);" }] },
    };
    const allow = { allow: [{ path: "src/store.ts", reason: "the enforcement point" }] };
    expect(cases(rule, { rules: { "local/no-save": allow } })).toEqual([]);
    expect(cases(rule)).toEqual([
      expect.stringContaining("allowed-exception case 1 was reported at line 1"),
    ]);
    // The mirror: an allowance that covers a must-fail case's path names the allowance.
    const everywhere = { allow: [{ path: "src/**", reason: "the whole tree, by mistake" }] };
    expect(cases(noSave, { rules: { "local/no-save": everywhere } })).toEqual([
      expect.stringContaining(
        "local/no-save's must-fail case 1 is at src/case.ts, which rules[\"local/no-save\"].allow allows, so it can't fail; give the case another `path`",
      ),
    ]);
  });

  test("an allowed case sees its own path, so a rule can exempt its enforcement point", () => {
    const exempting = defineRule({
      ...noSave,
      check: (file) => (file.path === "src/merge.ts" ? [] : noSave.check(file)),
      cases: { ...noSave.cases, allowed: [{ path: "src/merge.ts", source: "save(x);" }] },
    });
    expect(cases(exempting)).toEqual([]);
  });
});

describe("local rules on disk", () => {
  const API = join(import.meta.dir, "..", "..", "src", "api", "monkeyshape.ts");
  const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
  const RULE = `import { defineRule, walk } from ${JSON.stringify(API)};
export default defineRule({
  id: "no-save",
  bugClass: "Writes that skip the merge, replacing what earlier runs recorded.",
  message: "calls save directly; write through saveMerged.",
  cases: { fail: ["save(x);"], pass: ["saveMerged(x);"] },
  check: (file) => {
    const found: Array<{ offset: number }> = [];
    walk(file.program, {
      CallExpression: (node) => {
        if (node.callee.type === "Identifier" && node.callee.name === "save") found.push({ offset: node.start });
      },
    });
    return found;
  },
});
`;
  const CONFIG = `import noSave from "./rules/noSave.ts";
export default { localRules: [noSave] };
`;

  const scratch = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "mshape-local-"));
    for (const [path, text] of Object.entries(files)) await Bun.write(join(dir, path), text);
    await spawn(dir, ["git", "init", "-q"]);
    return dir;
  };

  const check = async (files: Record<string, string>) => {
    const dir = await scratch(files);
    try {
      return await spawn(dir, [process.execPath, CLI, "check", "--only", "rules"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("an adopter's rule module fails the gate on its bug and passes on the fix", async () => {
    const files = { "shape.config.ts": CONFIG, "rules/noSave.ts": RULE };
    const failed = await check({ ...files, "src/a.ts": "save(records);\n" });
    expect(failed.output).toContain("rules/local/no-save");
    expect(failed.output).toContain("src/a.ts:1");
    expect(failed.code).toBe(1);
    const passed = await check({ ...files, "src/a.ts": "saveMerged(prior, records);\n" });
    expect(passed.output).not.toContain("rules/local");
    expect(passed.code).toBe(0);
  });

  test("a rule module that doesn't load, or the config names one that isn't there, fails the gate", async () => {
    const broken = await check({
      "shape.config.ts": CONFIG,
      "rules/noSave.ts": "export default defineRule({ id: ;\n",
      "src/a.ts": "",
    });
    expect(broken.output).toContain("shape.config.ts: could not load");
    expect(broken.code).toBe(2);
    const missing = await check({ "shape.config.ts": CONFIG, "src/a.ts": "" });
    expect(missing.output).toContain("Cannot find module './rules/noSave.ts'");
    expect(missing.code).toBe(2);
  });

  test("mshape rules lists the repo's own rules beside the registry's, and works with no config", async () => {
    const rules = async (files: Record<string, string>) => {
      const dir = await scratch(files);
      try {
        return await spawn(dir, [process.execPath, CLI, "rules"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    };
    const listed = await rules({ "shape.config.ts": CONFIG, "rules/noSave.ts": RULE });
    expect(listed.output).toContain("no-throw ");
    expect(listed.output).toMatch(
      /\nlocal\/no-save +local +Writes that skip the merge, replacing what earlier runs recorded\.\n?$/,
    );
    expect(listed.code).toBe(0);
    const typo = await (async () => {
      const dir = await scratch({ "shape.config.ts": CONFIG, "rules/noSave.ts": RULE });
      try {
        return await spawn(dir, [process.execPath, CLI, "rules", "--config", "nope.ts"]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    })();
    expect(typo.output).toContain("shape.config.ts: not found");
    expect(typo.code).toBe(2);
    const bare = await rules({});
    expect(bare.output).toContain("no-throw ");
    expect(bare.output).not.toContain("local/");
    expect(bare.code).toBe(0);
    const broken = await rules({
      "shape.config.ts": CONFIG,
      "rules/noSave.ts": "export default { id: 'no-save' };\n",
    });
    expect(broken.output).toContain(
      "1 localRules entry is not a rule: `mshape check --only rules` says why",
    );
  });

  test("a module whose default export isn't a rule fails the gate, naming the shape", async () => {
    const result = await check({
      "shape.config.ts": CONFIG,
      "rules/noSave.ts": "export default { id: 'no-save' };\n",
      "src/a.ts": "",
    });
    expect(result.output).toContain("rules/local-rule");
    expect(result.output).toContain("needs a `bugClass`");
    expect(result.code).toBe(1);
  });
});

describe("local rules in garden's numbers", () => {
  test("each local rule's ignores and allowances, by name, including one with none", () => {
    const other = defineRule({ ...noSave, id: "other" });
    expect(
      localRuleHatches(
        config({
          localRules: [noSave, other],
          rules: { "local/no-save": { allow: [{ path: "src/merge.ts", reason: "the merge" }] } },
        }),
        repo({
          "src/a.ts": `// shape-ignore local/no-save: ${"generated, reviewed"}\nsave(x);\n// shape-ignore no-throw: a registry rule's\nthrow x;\n`,
          "src/a.test.ts": "// shape-ignore local/no-save: tests are out of scope\n",
        }),
      ),
    ).toEqual([
      { rule: "rules/local/no-save", ignores: 1, allowances: 1 },
      { rule: "rules/local/other", ignores: 0, allowances: 0 },
    ]);
  });
});
