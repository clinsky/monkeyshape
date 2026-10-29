/**
 * Module layering as data. Every source file under `arch.root` belongs to exactly one
 * module (the longest matching key in `arch.modules`). A module may import itself and the
 * modules in its `mayImport`; host APIs only with `hostAccess`; third-party packages only
 * from the allowlists. Adding an edge is a deliberate edit to `shape.config.ts`.
 *
 * Host access needs no import in Bun: `Bun.file`, `process`, `fetch` are globals. Those
 * are checked too, so a module without hostAccess can't reach the host by the side door.
 */

import { Visitor } from "oxc-parser";
import type { ResolvedConfig } from "../schemas/config.ts";
import { isTsSource, lineAt, type Snapshot, type Violation } from "./model.ts";
import { type Parsed, parse } from "./parse.ts";
import { dirname, join } from "./paths.ts";

type Arch = NonNullable<ResolvedConfig["arch"]>;

const MANIFEST = "package.json";

const violation = (rule: string, file: string, message: string, line?: number): Violation => ({
  check: "arch",
  rule: `arch/${rule}`,
  file,
  ...(line === undefined ? {} : { line }),
  message,
});

/** Bun's pure utilities: string and data functions with no I/O. */
const PURE_BUN = new Set(["Glob", "deepEquals", "escapeHTML", "stringWidth", "hash", "inspect"]);
const HOST_OBJECTS = new Set(["Bun", "process", "Deno"]);
const HOST_FUNCTIONS = new Set(["fetch", "require"]);

/** Names a binding pattern declares: `x`, `{ a, b: c }`, `[d, ...e]`, `f = 1`. */
const patternNames = (pattern: unknown): ReadonlyArray<string> => {
  if (typeof pattern !== "object" || pattern === null || !("type" in pattern)) return [];
  const node = pattern as Record<string, unknown>;
  switch (node["type"]) {
    case "Identifier":
      return typeof node["name"] === "string" ? [node["name"]] : [];
    case "ObjectPattern":
      return (node["properties"] as ReadonlyArray<Record<string, unknown>>).flatMap((p) =>
        patternNames(p["type"] === "RestElement" ? p["argument"] : p["value"]),
      );
    case "ArrayPattern":
      return (node["elements"] as ReadonlyArray<unknown>).flatMap(patternNames);
    case "AssignmentPattern":
      return patternNames(node["left"]);
    case "RestElement":
      return patternNames(node["argument"]);
    case "TSParameterProperty":
      return patternNames(node["parameter"]);
    default:
      return [];
  }
};

/**
 * Names the file declares anywhere. A local `process` (a spawned child, a metrics record)
 * shadows the global; without scope analysis, any declaration of the name counts.
 */
const declaredNames = (parsed: Parsed): ReadonlySet<string> => {
  const names = new Set<string>();
  const add = (pattern: unknown) => {
    for (const name of patternNames(pattern)) names.add(name);
  };
  const fn = (node: { readonly params: ReadonlyArray<unknown> }) => node.params.forEach(add);
  new Visitor({
    VariableDeclarator: (node) => add(node.id),
    FunctionDeclaration: (node) => {
      add(node.id);
      fn(node);
    },
    FunctionExpression: fn,
    ArrowFunctionExpression: fn,
    CatchClause: (node) => add(node.param),
    ImportSpecifier: (node) => add(node.local),
    ImportDefaultSpecifier: (node) => add(node.local),
    ImportNamespaceSpecifier: (node) => add(node.local),
  }).visit(parsed.program);
  return names;
};

/** Uses of host globals: `Bun.file(...)`, `process.cwd()`, `fetch(...)`, unless shadowed. */
export const hostGlobals = (parsed: Parsed): ReadonlyArray<{ offset: number; name: string }> => {
  const found: Array<{ offset: number; name: string }> = [];
  const declared = declaredNames(parsed);
  new Visitor({
    MemberExpression: (node) => {
      if (node.object.type !== "Identifier" || !HOST_OBJECTS.has(node.object.name)) return;
      if (declared.has(node.object.name)) return;
      const property =
        !node.computed && node.property.type === "Identifier" ? node.property.name : "";
      if (node.object.name === "Bun" && PURE_BUN.has(property)) return;
      found.push({ offset: node.start, name: `${node.object.name}.${property || "[...]"}` });
    },
    CallExpression: (node) => {
      if (
        node.callee.type === "Identifier" &&
        HOST_FUNCTIONS.has(node.callee.name) &&
        !declared.has(node.callee.name)
      )
        found.push({ offset: node.start, name: `${node.callee.name}()` });
    },
  }).visit(parsed.program);
  return found;
};

export const moduleOf = (arch: Arch, path: string): string | undefined => {
  const prefix = `${arch.root}/`;
  if (!path.startsWith(prefix)) return undefined;
  const rest = path.slice(prefix.length);
  let best: string | undefined;
  for (const name of Object.keys(arch.modules))
    if (
      (rest === name || rest.startsWith(`${name}/`)) &&
      (best === undefined || name.length > best.length)
    )
      best = name;
  return best;
};

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

/** `node:*` matches `node:fs/promises`: a trailing `*` is a prefix, not a path glob. */
export const matchesSpecifier = (specifier: string, pattern: string): boolean =>
  pattern.endsWith("*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern;

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

export const checkArch = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const arch = config.arch;
  if (arch === undefined)
    return [
      violation(
        "no-module-map",
        "shape.config.ts",
        "declares no `arch.modules`. Layering is the cheapest structure to enforce; map every source directory to a module.",
      ),
    ];

  const violations: Array<Violation> = [];
  for (const [name, rule] of Object.entries(arch.modules))
    for (const target of rule.mayImport ?? [])
      if (!Object.hasOwn(arch.modules, target))
        violations.push(
          violation(
            "config",
            "shape.config.ts",
            `module '${name}' lists unknown module '${target}' in mayImport`,
          ),
        );

  const files = snapshot.files.filter(
    (file) => file.startsWith(`${arch.root}/`) && isTsSource(file),
  );
  const known = new Set(snapshot.files);
  const edges = new Map<string, Array<string>>();

  for (const file of files) {
    const from = moduleOf(arch, file);
    if (from === undefined) {
      violations.push(
        violation(
          "unknown-module",
          file,
          "is not inside any module in `arch.modules` (shape.config.ts)",
        ),
      );
      continue;
    }
    const rule = arch.modules[from];
    const text = snapshot.texts.get(file);
    if (rule === undefined || text === undefined) continue;
    const targets: Array<string> = [];
    const parsed = parse(file, text);

    if (rule.hostAccess !== true)
      for (const use of hostGlobals(parsed))
        violations.push(
          violation(
            "host-access",
            file,
            `uses ${use.name}, but module '${from}' has no hostAccess. Reach the host through a service in an adapter module.`,
            lineAt(text, use.offset),
          ),
        );

    for (const specifier of parsed.imports) {
      if (!isRelative(specifier)) {
        const host = arch.hostSpecifiers.some((pattern) => matchesSpecifier(specifier, pattern));
        const allowed = host
          ? rule.hostAccess === true
          : arch.allowedPackages.includes(packageName(specifier)) ||
            (rule.packages ?? []).includes(packageName(specifier));
        if (!allowed)
          violations.push(
            violation(
              host ? "host-access" : "forbidden-package",
              file,
              host
                ? `imports '${specifier}', but module '${from}' has no hostAccess. Reach the host through a service in an adapter module.`
                : `imports '${specifier}', which module '${from}' may not use. Add it to the module's packages deliberately, or keep it behind an adapter.`,
            ),
          );
        continue;
      }
      const target = join(dirname(file), specifier);
      if (target === MANIFEST) {
        if (rule.manifest !== true)
          violations.push(
            violation("manifest", file, `module '${from}' may not import package.json`),
          );
        continue;
      }
      if (!known.has(target)) {
        violations.push(
          violation(
            "unresolved-import",
            file,
            `cannot resolve '${specifier}' (use explicit .ts extensions)`,
          ),
        );
        continue;
      }
      targets.push(target);
      const to = moduleOf(arch, target);
      if (to !== undefined && to !== from && !(rule.mayImport ?? []).includes(to))
        violations.push(
          violation(
            "forbidden-import",
            file,
            `module '${from}' may not import module '${to}' ('${specifier}')`,
          ),
        );
    }
    edges.set(file, targets);
  }

  for (const cycle of findCycles(edges))
    violations.push(violation("cycle", cycle[0] ?? "", `import cycle: ${cycle.join(" -> ")}`));
  return violations;
};

/** Depth-first search reporting each back edge as a cycle (file-level). */
export const findCycles = (
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const cycles: Array<ReadonlyArray<string>> = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: Array<string> = [];

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const nextState = state.get(next);
      if (nextState === "visiting") cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (nextState === undefined) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };

  for (const node of [...edges.keys()].sort()) if (!state.has(node)) visit(node);
  return cycles;
};
