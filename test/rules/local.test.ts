import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineRule, type Node, walk } from "../../src/api/monkeyshape.ts";
import { checkRules } from "../../src/core/rules/engine.ts";
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
});

const run = (files: Record<string, string>, input: ShapeConfig = {}) =>
  checkRules(config({ localRules: [noSave], ...input }), repo(files), []).map(
    (v) => `${v.rule} ${v.file}:${v.line} ${v.message}`,
  );

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
      expect.stringContaining("shape.config.ts:1 localRules[1] is string, not a rule: export"),
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
});

describe("local rules on disk", () => {
  const API = join(import.meta.dir, "..", "..", "src", "api", "monkeyshape.ts");
  const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
  const RULE = `import { defineRule, walk } from ${JSON.stringify(API)};
export default defineRule({
  id: "no-save",
  bugClass: "Writes that skip the merge, replacing what earlier runs recorded.",
  message: "calls save directly; write through saveMerged.",
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
