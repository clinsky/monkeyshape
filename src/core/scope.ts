/**
 * Lexical scopes, just enough to answer "does this name, at this offset, refer to a local
 * binding?" A binding is visible over its scope's whole span (hoisting and the temporal dead
 * zone are ignored: both still mean the name is local there).
 *
 * - `var` and function declarations bind in the nearest function (or the module).
 * - `let`, `const` and classes bind in the nearest block.
 * - Parameters bind in their function; a function expression's own name binds in itself.
 * - A catch parameter binds in its clause; imports bind in the module.
 */
import { type Program, visitorKeys } from "oxc-parser";

interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly [key: string]: unknown;
}

const isNode = (value: unknown): value is Node =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { type?: unknown }).type === "string" &&
  typeof (value as { start?: unknown }).start === "number";

const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const BLOCKS = new Set([
  "Program",
  "BlockStatement",
  "StaticBlock",
  "ForStatement",
  "ForInStatement",
  "ForOfStatement",
  "SwitchStatement",
  "CatchClause",
  ...FUNCTIONS,
]);

/** Names a binding pattern declares: `x`, `{ a, b: c }`, `[d, ...e]`, `f = 1`. */
export const patternNames = (pattern: unknown): ReadonlyArray<string> => {
  if (!isNode(pattern)) return [];
  switch (pattern.type) {
    case "Identifier":
      return typeof pattern["name"] === "string" ? [pattern["name"]] : [];
    case "ObjectPattern":
      return (pattern["properties"] as ReadonlyArray<Node>).flatMap((p) =>
        patternNames(p.type === "RestElement" ? p["argument"] : p["value"]),
      );
    case "ArrayPattern":
      return (pattern["elements"] as ReadonlyArray<unknown>).flatMap(patternNames);
    case "AssignmentPattern":
      return patternNames(pattern["left"]);
    case "RestElement":
      return patternNames(pattern["argument"]);
    case "TSParameterProperty":
      return patternNames(pattern["parameter"]);
    default:
      return [];
  }
};

export interface Scopes {
  /** Whether `name` at `offset` refers to a binding declared in the file. */
  readonly isLocal: (name: string, offset: number) => boolean;
}

export const scopes = (program: Program): Scopes => {
  const bindings = new Map<string, Array<{ start: number; end: number }>>();
  const bind = (pattern: unknown, scope: Node | undefined) => {
    if (scope === undefined) return;
    for (const name of patternNames(pattern)) {
      const ranges = bindings.get(name) ?? [];
      ranges.push({ start: scope.start, end: scope.end });
      bindings.set(name, ranges);
    }
  };

  const walk = (node: Node, stack: Array<Node>) => {
    const block = stack.at(-1);
    const fn = stack.findLast((s) => FUNCTIONS.has(s.type) || s.type === "Program");
    switch (node.type) {
      case "VariableDeclaration":
        for (const declarator of node["declarations"] as ReadonlyArray<Node>)
          bind(declarator["id"], node["kind"] === "var" ? fn : block);
        break;
      case "FunctionDeclaration":
        bind(node["id"], block);
        break;
      case "ClassDeclaration":
        bind(node["id"], block);
        break;
      case "ImportSpecifier":
      case "ImportDefaultSpecifier":
      case "ImportNamespaceSpecifier":
        bind(node["local"], stack[0]);
        break;
    }
    if (FUNCTIONS.has(node.type)) {
      for (const param of node["params"] as ReadonlyArray<unknown>) bind(param, node);
      if (node.type === "FunctionExpression") bind(node["id"], node);
    }
    if (node.type === "CatchClause") bind(node["param"], node);

    const scoped = BLOCKS.has(node.type);
    if (scoped) stack.push(node);
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) {
        for (const item of child) if (isNode(item)) walk(item, stack);
      } else if (isNode(child)) walk(child, stack);
    }
    if (scoped) stack.pop();
  };

  walk(program as unknown as Node, []);
  return {
    isLocal: (name, offset) =>
      (bindings.get(name) ?? []).some((range) => offset >= range.start && offset < range.end),
  };
};
