/**
 * Console output belongs to entry files: library code that prints decides, on behalf of every
 * caller, where text goes and that it goes at all. Entry files are `entry` in shape.config.ts,
 * so this follows the config wherever entries live; biome's own noConsole, which can't read
 * the config, stays on only for JavaScript (config/biome.base.json).
 *
 * Caught: any reference to the global `console` (a call, `globalThis.console`, destructuring
 * it, passing it whole). Not caught: reaching it through another alias of `globalThis`.
 */
import { scopes } from "../scope.ts";
import type { Rule } from "./engine.ts";

export const noConsole: Rule = {
  id: "no-console",
  layer: "core",
  bugClass:
    "Library code writing to the console, which every caller then inherits and no test sees.",
  message:
    "writes to the console outside an entry file. Return the text to the caller, or log through Effect (Effect.log) so the entry decides where it goes; if this file is a composition root, add it to `entry` in shape.config.ts.",
  entryExempt: true,
  visit: (parsed, report) => {
    const local = scopes(parsed.program);
    const names = new Set<number>();
    const reported = new Set<number>();
    const once = (offset: number) => {
      if (reported.has(offset)) return;
      reported.add(offset);
      report({ offset });
    };
    return {
      MemberExpression: (node) => {
        if (!node.computed) names.add(node.property.start);
        if (
          node.object.type === "Identifier" &&
          node.object.name === "globalThis" &&
          !local.isLocal("globalThis", node.start) &&
          !node.computed &&
          node.property.type === "Identifier" &&
          node.property.name === "console"
        )
          once(node.start);
      },
      Property: (node) => {
        if (!node.computed && !node.shorthand) names.add(node.key.start);
      },
      Identifier: (node) => {
        if (node.name !== "console" || names.has(node.start)) return;
        if (!local.isLocal("console", node.start)) once(node.start);
      },
    };
  },
};
