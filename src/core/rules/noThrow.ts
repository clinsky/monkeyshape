import type { CallExpression, Class } from "oxc-parser";
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

/** Callbacks whose throw the runtime catches and types: throwing is how they fail. */
const CATCHING = new Set(["try", "tryPromise"]);

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
    let catching = 0;
    const isCatching = (node: CallExpression) => {
      const member = memberPath(node.callee);
      return (
        member !== undefined &&
        CATCHING.has(member.property) &&
        isEffectModule(bindings, member.object, "Effect")
      );
    };
    const errorClass = (node: Class) => {
      if (node.superClass?.type === "Identifier" && ERROR_CLASSES.has(node.superClass.name))
        report({ offset: node.start });
    };
    return {
      CallExpression: (node) => {
        if (isCatching(node)) catching++;
      },
      "CallExpression:exit": (node) => {
        if (isCatching(node)) catching--;
      },
      ThrowStatement: (node) => {
        if (catching === 0) report({ offset: node.start });
      },
      ClassDeclaration: errorClass,
      ClassExpression: errorClass,
    };
  },
};
