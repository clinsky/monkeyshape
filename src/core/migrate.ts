/**
 * `mshape config migrate`'s decisions, pure: from a decoded `shape.config.ts` and its source
 * text, the `shape.toml` to write and a note per key computed in code, or why it refuses. The
 * adapter imports the old config, checks the files, writes and deletes. The plan's migrate
 * table is `test/core/migrate.test.ts`.
 */
import * as Schema from "effect/Schema";
import {
  DEFAULT_COVERAGE_EXEMPT,
  DEFAULT_DOCS,
  DEFAULT_FORM_ONLY_DOCS,
  DEFAULT_NARRATIVE_DOCS,
  type ShapeConfig,
  ShapeToml,
} from "../schemas/config.ts";
import { parse } from "./parse.ts";
import { type BornPin, recordPin } from "./scaffold.ts";

/** Where a repo's own rules live once ported from `localRules`: `shape-rules/<id>.yml`. */
export const SHAPE_RULES_DIR = "shape-rules";

/** A bare TOML key, else a quoted one. */
const key = (name: string): string =>
  /^[A-Za-z0-9_-]+$/u.test(name) ? name : JSON.stringify(name);

const isTable = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A list's `{ add = [...] }` form, which reads as one value, so it is written inline. */
const isAdd = (value: unknown): boolean =>
  isTable(value) && Object.keys(value).length === 1 && Array.isArray(value["add"]);

/** A table with nothing in it, at any depth: it says nothing, so it isn't written. */
const isEmpty = (value: unknown): boolean => isTable(value) && Object.values(value).every(isEmpty);

/** A value on one line: TOML's basic strings take JSON's escapes. */
const inline = (value: unknown): string => {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isTable(value))
    return `{ ${Object.entries(value)
      .map(([name, item]) => `${key(name)} = ${inline(item)}`)
      .join(", ")} }`;
  return JSON.stringify(String(value));
};

/** `name = value`, an array one item per line once it is long or holds tables. */
const assignment = (name: string, value: unknown): string => {
  const one = `${key(name)} = ${inline(value)}`;
  if (!Array.isArray(value) || (one.length <= 100 && !value.some(isTable))) return one;
  return [`${key(name)} = [`, ...value.map((item) => `  ${inline(item)},`), "]"].join("\n");
};

/**
 * A table's keys as TOML: its plain values under `[path]`, then each subtable as its own
 * section. A table with no plain values gets no header of its own, only its subtables'.
 */
const section = (path: ReadonlyArray<string>, table: Readonly<Record<string, unknown>>) => {
  const kept = Object.entries(table).filter(([, value]) => !isEmpty(value));
  const plain = kept.filter(([, value]) => !isTable(value) || isAdd(value));
  const nested = kept.filter(([, value]) => isTable(value) && !isAdd(value));
  const out: Array<string> = [];
  if (plain.length > 0)
    out.push(
      [
        ...(path.length > 0 ? [`[${path.map(key).join(".")}]`] : []),
        ...plain.map(([name, value]) => assignment(name, value)),
      ].join("\n"),
    );
  for (const [name, value] of nested)
    out.push(...section([...path, name], value as Readonly<Record<string, unknown>>));
  return out;
};

/** A TOML document of `document`, sections separated by a blank line. */
export const toToml = (document: Readonly<Record<string, unknown>>): string =>
  `${section([], document).join("\n\n")}\n`;

/** A default list and where it sits in the camelCase config. */
const EXTENDABLE: ReadonlyArray<{
  readonly path: readonly [string, string];
  readonly defaults: ReadonlyArray<string>;
}> = [
  { path: ["refs", "docs"], defaults: DEFAULT_DOCS },
  { path: ["refs", "narrativeDocs"], defaults: DEFAULT_NARRATIVE_DOCS },
  { path: ["refs", "formOnlyDocs"], defaults: DEFAULT_FORM_ONLY_DOCS },
  { path: ["coverage", "exempt"], defaults: DEFAULT_COVERAGE_EXEMPT },
];

/**
 * A list with a default, as `shape.toml` says it most simply: dropped when it is the default,
 * `{ add = [...] }` when it is the default with entries after it (a spread of `DEFAULT_DOCS`
 * and three more), as written otherwise.
 */
const extendable = (list: ReadonlyArray<string>, defaults: ReadonlyArray<string>) => {
  const starts = defaults.every((item, i) => list[i] === item);
  if (!starts) return { value: list };
  const added = list.slice(defaults.length);
  return added.length === 0 ? { value: undefined } : { value: { add: added } };
};

/** `refs.formOnlyDocs` as `shape.toml` spells it: `refs.form-only-docs`. */
const kebab = (path: ReadonlyArray<string>): string =>
  path.map((part) => part.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)).join(".");

/** Whether an oxc node is a value written out, with nothing to evaluate. */
const literal = (node: { readonly type: string } & Record<string, unknown>): boolean => {
  switch (node.type) {
    case "Literal":
      return true;
    case "TemplateLiteral":
      return (node["expressions"] as ReadonlyArray<unknown>).length === 0;
    case "UnaryExpression":
      return node["operator"] === "-" && literal(node["argument"] as typeof node);
    case "ArrayExpression":
      return (node["elements"] as ReadonlyArray<typeof node | null>).every(
        (element) => element !== null && element.type !== "SpreadElement" && literal(element),
      );
    case "ObjectExpression":
      return (node["properties"] as ReadonlyArray<typeof node>).every(
        (property) =>
          property.type === "Property" &&
          property["computed"] === false &&
          literal(property["value"] as typeof node),
      );
    default:
      return false;
  }
};

/** A property's name as written: `docs`, `"no-throw"`. */
const propertyName = (property: Record<string, unknown>): string | undefined => {
  const name = property["key"] as { type: string; name?: string; value?: unknown };
  if (name.type === "Identifier") return name.name;
  return typeof name.value === "string" ? name.value : undefined;
};

/**
 * The key paths, camelCase as written, whose values the source computes (a spread, an
 * imported constant, a call): the deepest key whose value isn't written out. `defineConfig(…)`
 * and `export default {…}` are both read; anything else yields nothing to note.
 */
export const computedKeys = (source: string): ReadonlyArray<ReadonlyArray<string>> => {
  const { program } = parse("shape.config.ts", source);
  type Node = { readonly type: string } & Record<string, unknown>;
  const exported = (program.body as unknown as ReadonlyArray<Node>).find(
    (statement) => statement.type === "ExportDefaultDeclaration",
  )?.["declaration"] as Node | undefined;
  const call = exported?.type === "CallExpression" ? exported : undefined;
  const root = (call === undefined ? exported : (call["arguments"] as ReadonlyArray<Node>)[0]) as
    | Node
    | undefined;
  if (root?.type !== "ObjectExpression") return root === undefined ? [] : [[]];
  const found: Array<ReadonlyArray<string>> = [];
  const walk = (object: Node, path: ReadonlyArray<string>) => {
    for (const property of object["properties"] as ReadonlyArray<Node>) {
      if (property.type !== "Property" || property["computed"] === true) {
        found.push(path);
        continue;
      }
      const name = propertyName(property);
      if (name === undefined) continue;
      const value = property["value"] as Node;
      if (name === "localRules") continue;
      if (value.type === "ObjectExpression") walk(value, [...path, name]);
      else if (!literal(value)) found.push([...path, name]);
    }
  };
  walk(root, []);
  return found;
};

export type MigrationPlan =
  | { readonly refused: ReadonlyArray<string> }
  | { readonly toml: string; readonly notes: ReadonlyArray<string> };

/**
 * `shape.toml` for `config`, which `source` (shape.config.ts's text) declared. `ruleIds` are
 * its `localRules`' ids; `ported` the ones with a file under `shape-rules/`. Refuses while a
 * rule isn't ported: its function can't be data, and dropping it would drop a check.
 */
export const planMigration = (input: {
  readonly config: ShapeConfig;
  readonly source: string;
  readonly ruleIds: ReadonlyArray<string>;
  readonly ported: ReadonlySet<string>;
  readonly pin: BornPin;
}): MigrationPlan => {
  const unported = input.ruleIds.filter((id) => !input.ported.has(id));
  if (unported.length > 0)
    return {
      refused: [
        `localRules has ${unported.length === 1 ? "a rule" : "rules"} not yet ported to ${SHAPE_RULES_DIR}/: ${unported.join(", ")}. shape.toml holds data, and a rule's function isn't. Port each to ${SHAPE_RULES_DIR}/<id>.yml with its cases (docs/local-rules.md says how), then run mshape config migrate again; nothing was changed`,
      ],
    };
  const { localRules: _rules, ...rest } = input.config;
  const notes: Array<string> = [];
  const config: Record<string, unknown> = { ...rest };
  for (const { path, defaults } of EXTENDABLE) {
    const [table, list] = path;
    const holder = config[table] as Record<string, unknown> | undefined;
    const value = holder?.[list] as ReadonlyArray<string> | undefined;
    if (holder === undefined || value === undefined) continue;
    const simplest = extendable(value, defaults);
    const next = { ...holder };
    if (simplest.value === undefined) delete next[list];
    else next[list] = simplest.value;
    config[table] = next;
  }
  for (const path of computedKeys(input.source)) {
    if (path.length === 0) {
      notes.push(
        "the config isn't an object literal, so each key is written as the value it evaluated to",
      );
      continue;
    }
    const extended = EXTENDABLE.find((list) => list.path.join(".") === path.join("."));
    notes.push(
      extended === undefined
        ? `${kebab(path)}: computed in code; written as the value it evaluated to`
        : `${kebab(path)}: computed in code; written as \`{ add = [...] }\`, the entries after the default, so it keeps following the default`,
    );
  }
  if (input.ruleIds.length > 0)
    notes.push(
      `localRules: not written; ${input.ruleIds.join(", ")} run from ${SHAPE_RULES_DIR}/ instead. The modules that defined them are no longer read: delete them once you've checked the ports`,
    );
  const encoded = Schema.encodeSync(ShapeToml)({
    ...config,
    packs: ["typescript"],
  } as typeof ShapeToml.Type) as Record<string, unknown>;
  const { packs, mshape: _pin, ...tables } = encoded;
  const body = toToml({ packs, ...tables });
  const header =
    "# monkeyshape's config, migrated from shape.config.ts by `mshape config migrate`.\n";
  return { toml: recordPin(`${header}${body}`, input.pin), notes };
};
