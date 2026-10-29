import { describe, expect, test } from "bun:test";
import { checkRules } from "../../src/core/rules/engine.ts";
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
