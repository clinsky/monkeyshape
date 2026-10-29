import { describe, expect, test } from "bun:test";
import { noThrow } from "../../src/core/rules/noThrow.ts";
import { ruleLines } from "../support.ts";

describe("no-throw", () => {
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
