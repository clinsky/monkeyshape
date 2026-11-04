/**
 * Console output belongs to entry files: library code that prints decides, on behalf of every
 * caller, where text goes and that it goes at all. Entry files are `entry` in shape.config.ts,
 * so this follows the config wherever entries live; biome's own noConsole, which can't read
 * the config, stays on only for JavaScript (config/biome.base.json).
 *
 * Caught: any value reference to the global `console` (a call, `globalThis.console` or
 * `globalThis["console"]`, destructuring it, passing it whole). Names spelled `console` that
 * aren't values (keys, members, labels, types, import and export aliases) are not. Not caught:
 * reaching it through another alias of `globalThis`.
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
    /** A key or name that isn't a value reference, when it isn't computed. */
    const name = (key: unknown, computed = false) => {
      const n = key as { type?: string; start?: number } | null | undefined;
      if (!computed && n?.type === "Identifier" && typeof n.start === "number") names.add(n.start);
    };
    /** Every identifier in a type query (`typeof console.log`): types, never values. */
    const typeName = (expression: unknown): void => {
      const n = expression as { type?: string; left?: unknown; right?: unknown } | undefined;
      if (n?.type === "TSQualifiedName") {
        typeName(n.left);
        name(n.right);
      } else name(n);
    };
    const keyed = (node: { key: unknown; computed: boolean }) => name(node.key, node.computed);
    const labelled = (node: { label: unknown }) => name(node.label);
    return {
      MemberExpression: (node) => {
        if (!node.computed) names.add(node.property.start);
        const property = node.property;
        const consoleKey = node.computed
          ? property.type === "Literal" && property.value === "console"
          : property.type === "Identifier" && property.name === "console";
        if (
          node.object.type === "Identifier" &&
          node.object.name === "globalThis" &&
          !local.isLocal("globalThis", node.start) &&
          consoleKey
        )
          once(node.start);
      },
      Property: (node) => {
        if (!node.shorthand) keyed(node);
      },
      MethodDefinition: keyed,
      PropertyDefinition: keyed,
      AccessorProperty: keyed,
      TSAbstractMethodDefinition: keyed,
      TSAbstractPropertyDefinition: keyed,
      TSAbstractAccessorProperty: keyed,
      TSPropertySignature: keyed,
      TSMethodSignature: keyed,
      TSEnumMember: (node) => name(node.id),
      LabeledStatement: labelled,
      BreakStatement: labelled,
      ContinueStatement: labelled,
      TSTypeQuery: (node) => typeName(node.exprName),
      TSQualifiedName: (node) => typeName(node),
      ImportSpecifier: (node) => {
        if (node.imported.start !== node.local.start) name(node.imported);
      },
      ExportSpecifier: (node) => {
        if (node.exported.start !== node.local.start) name(node.exported);
      },
      Identifier: (node) => {
        if (node.name !== "console" || names.has(node.start)) return;
        if (!local.isLocal("console", node.start)) once(node.start);
      },
    };
  },
};
