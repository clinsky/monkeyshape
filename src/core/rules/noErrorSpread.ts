import type { Expression } from "oxc-parser";
import type { Rule } from "./engine.ts";

/** Names that mean an error. Not `e`: it is as often an element or entry as an error. */
const ERROR_NAME = /^(err|error|cause|failure|defect)$|Error$/i;

const errorLike = (expression: Expression): boolean =>
  (expression.type === "Identifier" && ERROR_NAME.test(expression.name)) ||
  (expression.type === "MemberExpression" &&
    !expression.computed &&
    expression.property.type === "Identifier" &&
    ERROR_NAME.test(expression.property.name));

export const noErrorSpread: Rule = {
  id: "no-error-spread",
  layer: "core",
  bugClass: "Errors copied by spreading, which drops the prototype, the stack and the cause.",
  message:
    "spreads an error into an object, losing its class, stack and cause. Pass the error itself as `cause`, or copy the fields you need by name.",
  entryExempt: false,
  visit: (_parsed, report) => ({
    ObjectExpression: (node) => {
      for (const property of node.properties)
        if (property.type === "SpreadElement" && errorLike(property.argument))
          report({ offset: property.start });
    },
  }),
};
