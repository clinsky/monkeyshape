import { describe, expect, test } from "bun:test";
import { parse } from "../../src/core/parse.ts";
import { scopes } from "../../src/core/scope.ts";

let counter = 0;

/** Whether each `process` mention (in order) refers to a local binding. */
const locality = (source: string): ReadonlyArray<boolean> => {
  const parsed = parse(`scope-${counter++}.ts`, source);
  const local = scopes(parsed.program);
  return [...source.matchAll(/process(?=\.)/g)].map((m) => local.isLocal("process", m.index));
};

describe("scopes", () => {
  test("a parameter shadows the global inside its function only", () => {
    const source = [
      "function format(process: string) {",
      "  return process.toUpperCase();",
      "}",
      "export const cwd = process.cwd();",
    ].join("\n");
    expect(locality(source)).toEqual([true, false]);
  });

  test("let and const are block-scoped; var is function-scoped", () => {
    const source = [
      "if (x) { const process = child; process.kill(); }",
      "process.exit(1);",
      "function f() { if (y) { var process = row; } return process.turns; }",
      "process.cwd();",
    ].join("\n");
    expect(locality(source)).toEqual([true, false, true, false]);
  });

  test("destructured, arrow, catch and for-of bindings", () => {
    const source = [
      "const row = ({ process }: Row) => process.turns;",
      "try { run(); } catch (process) { process.message; }",
      "for (const process of children) process.kill();",
      "process.env;",
    ].join("\n");
    expect(locality(source)).toEqual([true, true, true, false]);
  });

  test("imports and module-level declarations shadow everywhere in the module", () => {
    expect(locality('import process from "./fake.ts";\nprocess.cwd();')).toEqual([true]);
    expect(locality("process.cwd();\nconst process = fake;")).toEqual([true]);
  });
});
