import { describe, expect, test } from "bun:test";
import { noErrorSpread } from "../../src/core/rules/noErrorSpread.ts";
import { ruleLines } from "../support.ts";

describe("no-error-spread", () => {
  test("fails: spreading anything named like an error", () => {
    const source = [
      "new Wrapped({ ...error });",
      "const copy = { ...err, extra: 1 };",
      "log({ ...result.cause });",
      "const x = { ...parseError };",
    ].join("\n");
    expect(ruleLines(noErrorSpread, source)).toEqual([1, 2, 3, 4]);
  });

  test("passes: passing the error as cause, spreading other values", () => {
    const source = [
      "new Wrapped({ cause: error, reason: error.message });",
      "const merged = { ...defaults, ...options };",
      "const list = [...errors];",
      "for (const e of expectations) out.push({ ...e, outcome: 1 });",
    ].join("\n");
    expect(ruleLines(noErrorSpread, source)).toEqual([]);
  });
});
