import { describe, expect, test } from "bun:test";
import { noThrow } from "../../src/core/rules/noThrow.ts";
import { ruleLines } from "../support.ts";

describe("no-throw", () => {
  test("only the try callback is exempt: catch callbacks and other arguments are not", () => {
    const source = [
      "Effect.try({",
      "  try: () => JSON.parse(input),",
      "  catch: () => {",
      '    throw new Error("mapping failed");',
      "  },",
      "});",
      "Effect.tryPromise({ try: async () => 1, catch: (e) => { throw e; } });",
      "Effect.try(() => 1, () => { throw bad; });",
    ].join("\n");
    expect(ruleLines(noThrow, source)).toEqual([4, 7, 8]);
  });

  test("a throw nested in a function inside the try callback is still caught there", () => {
    expect(
      ruleLines(
        noThrow,
        "Effect.try({ try: () => items.map((i) => { if (!i) throw i; }), catch: f });",
      ),
    ).toEqual([]);
  });

  test("a throw after a catching callback closes is still reported", () => {
    expect(ruleLines(noThrow, "Effect.try(() => parse(x));\nthrow y;")).toEqual([2]);
  });

  test("fails: throw statements and Error subclasses", () => {
    const source = [
      'throw new Error("x");',
      "class Bad extends Error {}",
      "const Worse = class extends TypeError {};",
      "function f() { if (x) throw y; }",
    ].join("\n");
    expect(ruleLines(noThrow, source)).toEqual([1, 2, 3, 4]);
  });

  test("passes: tagged errors and Effect.fail", () => {
    const source = [
      'class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {}) {}',
      "return yield* Effect.fail(new NotFound());",
      "class Plain extends Base {}",
      'Effect.tryPromise({ try: async () => { if (!ok) throw new Error("HTTP 500"); }, catch: toTagged });',
      "Effect.try(() => { throw bad; });",
    ].join("\n");
    expect(ruleLines(noThrow, source)).toEqual([]);
  });
});
