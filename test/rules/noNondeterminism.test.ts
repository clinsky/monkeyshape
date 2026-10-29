import { describe, expect, test } from "bun:test";
import { noNondeterminism } from "../../src/core/rules/noNondeterminism.ts";
import { ruleLines } from "../support.ts";

describe("no-nondeterminism", () => {
  test("fails: clock, randomness, timers, environment, unstructured concurrency", () => {
    const source = [
      "Date.now();",
      "new Date();",
      "Math.random();",
      "setTimeout(f, 10);",
      "const home = process.env.HOME;",
      "await Promise.all(xs);",
      "performance.now();",
      "Bun.env.TOKEN;",
    ].join("\n");
    expect(ruleLines(noNondeterminism, source)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test("passes: explicit dates, Effect equivalents, lookalikes", () => {
    const source = [
      'new Date("2026-01-01");',
      "new Date(timestamp);",
      "yield* Clock.currentTimeMillis;",
      "Effect.all(effects);",
      "config.env;",
      "myPromise.all;",
    ].join("\n");
    expect(ruleLines(noNondeterminism, source)).toEqual([]);
  });
});
