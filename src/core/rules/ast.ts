/** Small AST helpers shared by the rules. */
import type { Expression, ModuleExportName, Program } from "oxc-parser";

/** `A.b` for a non-computed member access on an identifier, else undefined. */
export const memberPath = (
  expression: Expression,
): { object: string; property: string } | undefined =>
  expression.type === "MemberExpression" &&
  !expression.computed &&
  expression.object.type === "Identifier" &&
  expression.property.type === "Identifier"
    ? { object: expression.object.name, property: expression.property.name }
    : undefined;

const exportName = (name: ModuleExportName): string =>
  name.type === "Literal" ? String(name.value) : name.name;

/** What a local name was imported as: `{ source, imported }`, `imported` is `*` for namespaces. */
export type Bindings = ReadonlyMap<string, { readonly source: string; readonly imported: string }>;

export const importBindings = (program: Program): Bindings => {
  const bindings = new Map<string, { source: string; imported: string }>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") continue;
    for (const specifier of statement.specifiers) {
      const imported =
        specifier.type === "ImportSpecifier"
          ? exportName(specifier.imported)
          : specifier.type === "ImportNamespaceSpecifier"
            ? "*"
            : "default";
      bindings.set(specifier.local.name, { source: statement.source.value, imported });
    }
  }
  return bindings;
};

/**
 * Whether a local identifier names an Effect module (`Effect`, `Schema`): imported from
 * `effect` by that name, or as the namespace of `effect/<Module>`. Unbound uses of the
 * canonical name also count, since tests and snippets often omit imports.
 */
export const isEffectModule = (bindings: Bindings, local: string, module: string): boolean => {
  const binding = bindings.get(local);
  if (binding === undefined) return local === module;
  return (
    (binding.source === "effect" && binding.imported === module) ||
    (binding.source === `effect/${module}` && binding.imported === "*")
  );
};
