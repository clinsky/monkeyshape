import { describe, expect, test } from "bun:test";
import { checkRules } from "../../src/core/rules/engine.ts";
import { noConsole } from "../../src/core/rules/noConsole.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, repo, ruleLines } from "../support.ts";

describe("no-console", () => {
  test("fails: a call, globalThis.console, destructuring, and passing console whole", () => {
    expect(
      ruleLines(
        noConsole,
        [
          'console.log("x");',
          'globalThis.console.error("x");',
          "const { warn } = console;",
          "export const sink = (f: (c: Console) => void) => f(console);",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  test("passes: a local named console, and the Console type", () => {
    expect(
      ruleLines(
        noConsole,
        [
          'export const f = (console: { log: (s: string) => void }) => console.log("x");',
          "export type C = Console;",
          "export const g = (c: Console) => c;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("entry files may write to the console, wherever the config declares them", () => {
    const run = (shape: ShapeConfig) =>
      checkRules(
        config(shape),
        repo({ "app/main.ts": 'console.log("x");\n', "app/lib/a.ts": 'console.log("x");\n' }),
        [noConsole],
      ).map((v) => `${v.rule} ${v.file}`);
    const shape = { sources: { include: ["app/**/*.ts"] } };
    expect(run({ ...shape, entry: ["app/main.ts"] })).toEqual(["rules/no-console app/lib/a.ts"]);
    // The old biome override exempted src/cli/** and tools/**: here neither applies.
    expect(run(shape)).toEqual(["rules/no-console app/main.ts", "rules/no-console app/lib/a.ts"]);
  });

  test("tests are out of sources by default; a test put in sources is held to it, as intended", () => {
    const files = { "src/a.test.ts": 'console.log("x");\n' };
    expect(checkRules(config({}), repo(files), [noConsole])).toEqual([]);
    expect(
      checkRules(config({ sources: { include: ["src/**/*.ts"], exclude: [] } }), repo(files), [
        noConsole,
      ]).map((v) => v.rule),
    ).toEqual(["rules/no-console"]);
  });
});
