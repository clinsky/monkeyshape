import { memberPath } from "./ast.ts";
import type { Rule } from "./engine.ts";

const CALLS: ReadonlyMap<string, string> = new Map([
  ["Date.now", "reads the wall clock. Use Clock or DateTime.now so tests control time."],
  ["performance.now", "reads the wall clock. Use Clock so tests control time."],
  ["Math.random", "is unseeded randomness. Use Random so tests are reproducible."],
  [
    "Promise.all",
    "is unstructured concurrency: no interruption, no bound. Use Effect.all / Effect.forEach.",
  ],
  ["Promise.race", "is unstructured concurrency: the loser keeps running. Use Effect.race."],
  ["Promise.allSettled", 'is unstructured concurrency. Use Effect.all with { mode: "either" }.'],
  ["Promise.any", "is unstructured concurrency. Use Effect.firstSuccessOf."],
]);

const TIMERS: ReadonlyMap<string, string> = new Map([
  ["setTimeout", "is a real-time timer. Use Effect.sleep or Schedule so tests control time."],
  ["setInterval", "is a real-time timer. Use Schedule so tests control time."],
  ["setImmediate", "escapes the runtime. Use Effect.yieldNow."],
]);

export const noNondeterminism: Rule = {
  id: "no-nondeterminism",
  layer: "core",
  bugClass:
    "Hidden clock, randomness, environment and timers, which make runs irreproducible and caches wrong.",
  message: "reads the host directly. Go through an Effect service so tests and replays control it.",
  entryExempt: true,
  visit: (_parsed, report) => ({
    CallExpression: (node) => {
      const member = memberPath(node.callee);
      const hint =
        member !== undefined
          ? CALLS.get(`${member.object}.${member.property}`)
          : node.callee.type === "Identifier"
            ? TIMERS.get(node.callee.name)
            : undefined;
      if (hint !== undefined) report({ offset: node.start, message: hint });
    },
    NewExpression: (node) => {
      if (
        node.callee.type === "Identifier" &&
        node.callee.name === "Date" &&
        node.arguments.length === 0
      )
        report({
          offset: node.start,
          message: "reads the wall clock. Use Clock or DateTime.now so tests control time.",
        });
    },
    MemberExpression: (node) => {
      const member = memberPath(node);
      if (
        member !== undefined &&
        member.property === "env" &&
        (member.object === "process" || member.object === "Bun")
      )
        report({
          offset: node.start,
          message: "reads the environment directly. Use Config, provided at the composition root.",
        });
    },
  }),
};
