/**
 * Decoding that refuses unknown keys. A decode passes when it is strict wherever its options
 * are written (inline, in a same-file `const` or an alias of one, spread into an object, or
 * passed to the decoder it returns) or when its schema has no properties for an excess key to
 * hide in (a branded string, a literal, an array or union of those). What the file can't
 * show, such as an imported schema or options from a parameter, is reported: the rule judges
 * only what it sees, and a name that shadows a const is not that const.
 */
import { type CallExpression, type Program, Visitor } from "oxc-parser";
import { type Scopes, scopes } from "../scope.ts";
import { type Bindings, importBindings, isEffectModule } from "./ast.ts";
import type { Rule } from "./engine.ts";

const DECODERS = new Set([
  "decodeUnknownEffect",
  "decodeEffect",
  "decodeUnknownExit",
  "decodeExit",
  "decodeUnknownOption",
  "decodeOption",
  "decodeUnknownResult",
  "decodeResult",
  "decodeUnknownPromise",
  "decodePromise",
  "decodeUnknownSync",
  "decodeSync",
]);

/** Schemas whose values have no properties: an excess key can't occur in them. */
const LEAVES = new Set([
  "String",
  "Number",
  "Boolean",
  "BigInt",
  "Symbol",
  "Null",
  "Undefined",
  "Void",
  "Never",
  "Finite",
  "Int",
  "NonEmptyString",
  "Trimmed",
  "Literal",
  "Literals",
  "TemplateLiteral",
  "Enum",
  "Enums",
]);

/** Combinators whose values have properties only if their members do. */
const OF_MEMBERS = new Set([
  "Array",
  "NonEmptyArray",
  "Union",
  "NullOr",
  "UndefinedOr",
  "NullishOr",
]);

/** Methods and pipe steps that refine or brand a schema without adding properties. */
const REFINING = new Set(["pipe", "check", "annotate", "brand"]);
const REFINING_STEPS = new Set(["brand", "check", "annotate"]);

/** How many const aliases the rule follows: enough for real code, never a cycle. */
const DEPTH = 8;

interface Node {
  readonly type: string;
  readonly start: number;
  readonly [key: string]: unknown;
}

const node = (value: unknown): Node | undefined =>
  typeof value === "object" && value !== null && typeof (value as Node).type === "string"
    ? (value as Node)
    : undefined;

/** Through `(x)`, `x as const`, `x satisfies T` and `x!`, to the expression itself. */
const unwrap = (value: unknown): Node | undefined => {
  const n = node(value);
  if (n === undefined) return undefined;
  if (
    n.type === "ParenthesizedExpression" ||
    n.type === "TSAsExpression" ||
    n.type === "TSSatisfiesExpression" ||
    n.type === "TSNonNullExpression"
  )
    return unwrap(n["expression"]);
  return n;
};

interface Context {
  readonly bindings: Bindings;
  readonly local: Scopes;
}

/** An identifier's value, when it names a same-file `const`; undefined otherwise. */
const constValue = (ctx: Context, n: Node): Node | undefined => {
  if (n.type !== "Identifier" || typeof n["name"] !== "string") return undefined;
  const declaration = ctx.local.bindingAt(n["name"], n.start);
  return declaration?.kind === "const" ? unwrap(declaration.init) : undefined;
};

/** Whether `n` is effect's `Schema` module: imported as such, or a const alias of it. */
const isSchema = (ctx: Context, value: unknown, depth = 0): boolean => {
  const n = unwrap(value);
  if (n === undefined || n.type !== "Identifier" || depth > DEPTH) return false;
  const name = n["name"] as string;
  const declaration = ctx.local.bindingAt(name, n.start);
  if (declaration === undefined || declaration.kind === "import")
    return isEffectModule(ctx.bindings, name, "Schema");
  const aliased = constValue(ctx, n);
  return aliased !== undefined && isSchema(ctx, aliased, depth + 1);
};

/** `Schema.<name>` (or an alias's), as the member's name; undefined for anything else. */
const schemaMember = (ctx: Context, value: unknown): string | undefined => {
  const n = unwrap(value);
  if (n?.type !== "MemberExpression" || n["computed"] === true) return undefined;
  const property = node(n["property"]);
  return property?.type === "Identifier" && isSchema(ctx, n["object"])
    ? (property["name"] as string)
    : undefined;
};

/** Whether a callee is one of Schema's decoders, directly, imported, or by a const alias. */
const isDecoder = (ctx: Context, callee: unknown, depth = 0): boolean => {
  const n = unwrap(callee);
  if (n === undefined || depth > DEPTH) return false;
  const member = schemaMember(ctx, n);
  if (member !== undefined) return DECODERS.has(member);
  if (n.type !== "Identifier") return false;
  const name = n["name"] as string;
  const declaration = ctx.local.bindingAt(name, n.start);
  if (declaration?.kind === "import") {
    const binding = ctx.bindings.get(name);
    return binding?.source === "effect/Schema" && DECODERS.has(binding.imported);
  }
  const aliased = constValue(ctx, n);
  return aliased !== undefined && isDecoder(ctx, aliased, depth + 1);
};

/**
 * What an options object says of `onExcessProperty`, in source order so a later key or
 * spread wins: `"error"`, another value, or undefined when it doesn't say or can't be seen.
 */
const excessSetting = (ctx: Context, value: unknown, depth = 0): unknown => {
  const n = unwrap(value);
  if (n === undefined || depth > DEPTH) return undefined;
  const aliased = constValue(ctx, n);
  if (aliased !== undefined) return excessSetting(ctx, aliased, depth + 1);
  if (n.type !== "ObjectExpression") return undefined;
  let setting: unknown;
  for (const property of n["properties"] as ReadonlyArray<Node>) {
    if (property.type === "SpreadElement") {
      const spread = excessSetting(ctx, property["argument"], depth + 1);
      if (spread !== undefined) setting = spread;
      continue;
    }
    const key = node(property["key"]);
    const named =
      property["computed"] !== true &&
      ((key?.type === "Identifier" && key["name"] === "onExcessProperty") ||
        (key?.type === "Literal" && key["value"] === "onExcessProperty"));
    if (!named) continue;
    const literal = unwrap(property["value"]);
    setting = literal?.type === "Literal" ? literal["value"] : "unknown";
  }
  return setting;
};

/** Whether a schema expression's values can't carry properties, as far as the file shows. */
const propertyless = (ctx: Context, value: unknown, depth = 0): boolean => {
  const n = unwrap(value);
  if (n === undefined || depth > DEPTH) return false;
  const aliased = constValue(ctx, n);
  if (aliased !== undefined) return propertyless(ctx, aliased, depth + 1);
  const leaf = schemaMember(ctx, n);
  if (leaf !== undefined) return LEAVES.has(leaf);
  if (n.type !== "CallExpression") return false;
  const callee = unwrap(n["callee"]);
  const args = (n["arguments"] as ReadonlyArray<unknown>).map(unwrap);
  const combinator = schemaMember(ctx, callee);
  if (combinator !== undefined) {
    if (LEAVES.has(combinator)) return true;
    if (!OF_MEMBERS.has(combinator)) return false;
    const members = args.flatMap((arg) =>
      arg?.type === "ArrayExpression" ? (arg["elements"] as ReadonlyArray<unknown>) : [arg],
    );
    return members.length > 0 && members.every((m) => propertyless(ctx, m, depth + 1));
  }
  // `X.pipe(Schema.brand(...))`, `X.check(...)`, `X.annotate(...)`: X's shape, unchanged,
  // as long as every pipe step is one that only refines.
  if (callee?.type !== "MemberExpression" || callee["computed"] === true) return false;
  const method = node(callee["property"]);
  if (method?.type !== "Identifier" || !REFINING.has(method["name"] as string)) return false;
  if (method["name"] === "pipe")
    for (const step of args) {
      const stepCallee = step?.type === "CallExpression" ? unwrap(step["callee"]) : undefined;
      const name = schemaMember(ctx, stepCallee);
      if (name === undefined || !REFINING_STEPS.has(name)) return false;
    }
  return propertyless(ctx, callee["object"], depth + 1);
};

/** Each decoder call, with the options it is made with and those its decoder is called with. */
const decodes = (ctx: Context, program: Program) => {
  const found = new Map<number, { call: CallExpression; invokedWith?: unknown }>();
  new Visitor({
    CallExpression: (call) => {
      if (isDecoder(ctx, call.callee)) found.set(call.start, { ...found.get(call.start), call });
      const inner = unwrap(call.callee);
      if (inner?.type === "CallExpression" && isDecoder(ctx, inner["callee"]))
        found.set(inner.start, {
          ...(found.get(inner.start) ?? { call: inner as unknown as CallExpression }),
          invokedWith: call.arguments[1],
        });
    },
  }).visit(program);
  return [...found.values()];
};

export const decodeStrict: Rule = {
  id: "decode-strict",
  layer: "core",
  bugClass:
    "Unknown keys silently dropped while decoding, so a misspelt or stale field is ignored.",
  message:
    'decodes without onExcessProperty: "error". Use decodeStrict from monkeyshape, or pass { errors: "all", onExcessProperty: "error" } (inline or in a const in this file).',
  entryExempt: false,
  visit: (parsed, report) => {
    const ctx: Context = {
      bindings: importBindings(parsed.program),
      local: scopes(parsed.program),
    };
    for (const { call, invokedWith } of decodes(ctx, parsed.program)) {
      const strict =
        excessSetting(ctx, call.arguments[1]) === "error" ||
        excessSetting(ctx, invokedWith) === "error";
      if (!strict && !propertyless(ctx, call.arguments[0])) report({ offset: call.start });
    }
    return {};
  },
};
