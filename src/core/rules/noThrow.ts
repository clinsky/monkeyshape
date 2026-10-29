import type { CallExpression, Class, Expression } from "oxc-parser";
import { importBindings, isEffectModule, memberPath } from "./ast.ts";
import type { Rule } from "./engine.ts";

const ERROR_CLASSES = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** `Effect.try` / `Effect.tryPromise`: the runtime catches what their `try` callback throws. */
const CATCHING = new Set(["try", "tryPromise"]);

const isFunction = (node: Expression | undefined): boolean =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

/**
 * The function whose throws are caught: the sole argument, or the `try` property of the
 * options object. Not `catch`, which maps an error that has already been caught.
 */
const tryCallback = (call: CallExpression): Expression | undefined => {
  const argument = call.arguments[0];
  if (argument === undefined || argument.type === "SpreadElement") return undefined;
  if (isFunction(argument)) return argument;
  if (argument.type !== "ObjectExpression") return undefined;
  for (const property of argument.properties)
    if (
      property.type === "Property" &&
      !property.computed &&
      property.key.type === "Identifier" &&
      property.key.name === "try" &&
      isFunction(property.value)
    )
      return property.value;
  return undefined;
};

export const noThrow: Rule = {
  id: "no-throw",
  layer: "core",
  bugClass:
    "Mixed error paradigms: thrown errors escape the typed error channel and turn into defects.",
  message:
    "throws or defines an Error class. Fail with a Schema.TaggedError (Effect.fail) so the error is typed and handled by tag.",
  entryExempt: false,
  visit: (parsed, report) => {
    const bindings = importBindings(parsed.program);
    const caught: Array<{ start: number; end: number }> = [];
    const errorClass = (node: Class) => {
      if (node.superClass?.type === "Identifier" && ERROR_CLASSES.has(node.superClass.name))
        report({ offset: node.start });
    };
    return {
      // Calls are visited before the throws inside them, so the ranges are known in time.
      CallExpression: (node) => {
        const member = memberPath(node.callee);
        if (
          member === undefined ||
          !CATCHING.has(member.property) ||
          !isEffectModule(bindings, member.object, "Effect")
        )
          return;
        const callback = tryCallback(node);
        if (callback !== undefined) caught.push({ start: callback.start, end: callback.end });
      },
      ThrowStatement: (node) => {
        if (!caught.some((range) => node.start >= range.start && node.end <= range.end))
          report({ offset: node.start });
      },
      ClassDeclaration: errorClass,
      ClassExpression: errorClass,
    };
  },
};
