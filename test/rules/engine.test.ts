import { describe, expect, test } from "bun:test";
import { checkRules, type Rule } from "../../src/core/rules/engine.ts";
import { RULES } from "../../src/core/rules/registry.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, repo } from "../support.ts";

const run = (files: Record<string, string>, input: ShapeConfig = {}) =>
  checkRules(config(input), repo(files), RULES).map(
    (v) => `${v.rule} ${v.file}${v.line === undefined ? "" : `:${v.line}`}`,
  );

describe("rule engine", () => {
  test("rules apply to sources only; tests are out by default", () => {
    expect(
      run({ "src/a.ts": "throw x;", "src/a.test.ts": "throw x;", "scripts/a.ts": "throw x;" }),
    ).toEqual(["rules/no-throw src/a.ts:1"]);
  });

  test("entry files may run effects and read the host; they still may not throw", () => {
    expect(run({ "src/cli/main.ts": "Effect.runPromise(p);\nDate.now();\nthrow x;" })).toEqual([
      "rules/no-throw src/cli/main.ts:3",
    ]);
  });

  test("shape-ignore with a reason covers its line and the next", () => {
    const source =
      "// shape-ignore no-throw: the framework callback requires it\nthrow x;\nthrow y; // shape-ignore no-throw: same callback contract\n";
    expect(run({ "src/a.ts": source })).toEqual([]);
  });

  test("a shape-ignore without a reason, or suppressing nothing, is itself a violation", () => {
    expect(run({ "src/a.ts": "// shape-ignore no-throw\nthrow x;\n" })).toEqual([
      "rules/ignore-without-reason src/a.ts:1",
      "rules/no-throw src/a.ts:2",
    ]);
    expect(
      run({ "src/a.ts": "// shape-ignore no-throw: nothing here throws at all\nconst x = 1;\n" }),
    ).toEqual(["rules/unused-ignore src/a.ts:1"]);
  });

  test("allowances need a reason and must still allow something", () => {
    const allow = {
      rules: {
        "no-throw": { allow: [{ path: "src/legacy/**", reason: "pre-Effect module, ratcheting" }] },
      },
    };
    expect(run({ "src/legacy/a.ts": "throw x;" }, allow)).toEqual([]);
    expect(run({ "src/a.ts": "" }, allow)).toEqual(["rules/unused-allowance shape.config.ts:1"]);
  });

  test("a rule can be turned off with a reason; unknown rules are config errors", () => {
    expect(
      run(
        { "src/a.ts": "throw x;" },
        { rules: { "no-throw": { off: "this repo is a plain library" } } },
      ),
    ).toEqual([]);
    expect(run({}, { rules: { "no-such-rule": {} } })).toEqual(["rules/config shape.config.ts:1"]);
  });

  test("files that don't parse are reported", () => {
    expect(run({ "src/a.ts": "const = ;" })[0]).toStartWith("rules/syntax src/a.ts");
  });
});

describe("a rule's context", () => {
  test("resolve gives the parsed file a relative import names, and nothing for anything else", () => {
    const seen: Array<string> = [];
    const probe: Rule = {
      id: "probe",
      layer: "core",
      bugClass: "none: a probe of the context",
      message: "none: a probe of the context",
      entryExempt: false,
      visit: (parsed, _report, context) => ({
        ImportDeclaration: (node) => {
          const target = context.resolve(node.source.value);
          seen.push(`${parsed.path} ${node.source.value} -> ${target?.path ?? "undefined"}`);
        },
      }),
    };
    const source = [
      'import { X } from "../schemas/case.ts";',
      'import { Y } from "./y.ts";',
      'import { Schema } from "effect";',
      'import { Z } from "./missing.ts";',
      'import { W } from "../../../outside.ts";',
    ].join("\n");
    checkRules(
      config(),
      repo({
        "src/core/a.ts": source,
        "src/core/y.ts": "",
        "src/schemas/case.ts": "export const X = 1;\n",
      }),
      [probe],
    );
    expect(seen.filter((line) => line.startsWith("src/core/a.ts"))).toEqual([
      "src/core/a.ts ../schemas/case.ts -> src/schemas/case.ts",
      "src/core/a.ts ./y.ts -> src/core/y.ts",
      "src/core/a.ts effect -> undefined",
      "src/core/a.ts ./missing.ts -> undefined",
      "src/core/a.ts ../../../outside.ts -> undefined",
    ]);
  });
});
