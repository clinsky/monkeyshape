import { describe, expect, test } from "bun:test";
import { effectRunAtEdge } from "../../src/core/rules/effectRunAtEdge.ts";
import { ruleLines } from "../support.ts";

describe("effect-run-at-edge", () => {
  test("fails: every Effect runner and runtime runMain", () => {
    const source = [
      'import { Effect } from "effect";',
      "Effect.runPromise(program);",
      "Effect.runSync(program);",
      "Effect.runFork(program);",
      "BunRuntime.runMain(program);",
    ].join("\n");
    expect(ruleLines(effectRunAtEdge, source)).toEqual([2, 3, 4, 5]);
    expect(
      ruleLines(effectRunAtEdge, 'import * as E from "effect/Effect";\nE.runPromiseExit(p);'),
    ).toEqual([2]);
  });

  test("passes: composing effects, and runners on unrelated objects", () => {
    const source = [
      'import { Effect } from "effect";',
      "const program = Effect.gen(function* () {});",
      "runner.runPromise(job);",
    ].join("\n");
    expect(ruleLines(effectRunAtEdge, source)).toEqual([]);
  });
});
