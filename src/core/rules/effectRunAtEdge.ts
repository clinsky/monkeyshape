import { importBindings, isEffectModule, memberPath } from "./ast.ts";
import type { Rule } from "./engine.ts";

const RUNNERS = new Set([
  "runPromise",
  "runPromiseExit",
  "runSync",
  "runSyncExit",
  "runFork",
  "runCallback",
]);

export const effectRunAtEdge: Rule = {
  id: "effect-run-at-edge",
  layer: "core",
  bugClass: "Nested runtimes that lose interruption, context and the typed error channel.",
  message:
    "runs an effect outside a composition root. Return the Effect and let the entry point (an `entry` file) run it.",
  entryExempt: true,
  visit: (parsed, report) => {
    const bindings = importBindings(parsed.program);
    return {
      CallExpression: (node) => {
        const member = memberPath(node.callee);
        if (member === undefined) return;
        const runner =
          RUNNERS.has(member.property) && isEffectModule(bindings, member.object, "Effect");
        const main = member.property === "runMain" && member.object.endsWith("Runtime");
        if (runner || main) report({ offset: node.start });
      },
    };
  },
};
