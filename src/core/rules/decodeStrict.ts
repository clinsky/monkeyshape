import type { CallExpression, Expression } from "oxc-parser";
import { importBindings, isEffectModule, memberPath } from "./ast.ts";
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

/** `{ ..., onExcessProperty: "error" }` passed where the decoder takes its options. */
const strictOptions = (call: CallExpression): boolean => {
  const options = call.arguments[1];
  return (
    options?.type === "ObjectExpression" &&
    options.properties.some(
      (property) =>
        property.type === "Property" &&
        property.key.type === "Identifier" &&
        property.key.name === "onExcessProperty" &&
        property.value.type === "Literal" &&
        property.value.value === "error",
    )
  );
};

export const decodeStrict: Rule = {
  id: "decode-strict",
  layer: "core",
  bugClass:
    "Unknown keys silently dropped while decoding, so a misspelt or stale field is ignored.",
  message:
    'decodes without onExcessProperty: "error". Use decodeStrict from monkeyshape, or pass { errors: "all", onExcessProperty: "error" }.',
  entryExempt: false,
  visit: (parsed, report) => {
    const bindings = importBindings(parsed.program);
    const isDecoder = (callee: Expression): boolean => {
      const member = memberPath(callee);
      if (member !== undefined)
        return DECODERS.has(member.property) && isEffectModule(bindings, member.object, "Schema");
      if (callee.type !== "Identifier") return false;
      const binding = bindings.get(callee.name);
      return binding?.source === "effect/Schema" && DECODERS.has(binding.imported);
    };
    return {
      CallExpression: (node) => {
        if (isDecoder(node.callee) && !strictOptions(node)) report({ offset: node.start });
      },
    };
  },
};
