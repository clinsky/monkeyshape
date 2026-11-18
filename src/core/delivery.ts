/**
 * The listed packs' base configs that `mshape sync` delivers by `copy` or `table` (`extends`
 * is the repo's own config naming the shipped file, so there is nothing to write). Pure: the
 * adapter reads the shipped copies and writes what `planDelivery` decides, and the `sync`
 * check holds a repo to the same plan.
 *
 * - `copy`: the shipped file at `.mshape/<name>`, byte for byte.
 * - `table`: TOML tables sync owns inside a repo file (Cargo's `[workspace.lints.*]`), compared
 *   by parsed value, so a reformat isn't a failure. Sync rewrites only those tables' sections
 *   and leaves every other line of the file as it was. Owned tables are written as `[a.b]`
 *   headers; one written as dotted keys under a parent header isn't sync's to rewrite, and
 *   the check says so.
 */
import type { BaseConfig, Pack } from "../packs/pack.ts";
import type { PackId, ResolvedConfig } from "../schemas/config.ts";

/** A base config as sync delivers it: where, and what it must hold. */
export type Delivery =
  | {
      readonly delivery: "copy";
      readonly pack: PackId;
      readonly file: string;
      readonly text: string;
    }
  | {
      readonly delivery: "table";
      readonly pack: PackId;
      readonly file: string;
      readonly tables: ReadonlyArray<string>;
      /** The tables' TOML text, headers included. */
      readonly text: string;
    };

/**
 * What each listed pack's `copy` and `table` configs must be. `shipped` holds the text of each
 * shipped file a `copy` names, by its path in the package; one it lacks is skipped (the
 * adapter reports a broken install).
 */
export const deliveries = (
  config: ResolvedConfig,
  packs: ReadonlyArray<Pack>,
  shipped: ReadonlyMap<string, string>,
): ReadonlyArray<Delivery> =>
  packs.flatMap((pack) =>
    pack.baseConfigs.flatMap((base: BaseConfig): ReadonlyArray<Delivery> => {
      if (base.delivery === "extends") return [];
      if (base.delivery === "table")
        return [
          {
            delivery: "table",
            pack: pack.id,
            file: base.file,
            tables: base.tables,
            text: base.content(config),
          },
        ];
      const text = shipped.get(base.shipped);
      return text === undefined
        ? []
        : [{ delivery: "copy", pack: pack.id, file: base.target, text }];
    }),
  );

const HEADER = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/;

/** The table a `[a.b]` header line opens, unquoted, or undefined for any other line. */
const headerOf = (line: string): string | undefined =>
  HEADER.exec(line)?.[1]
    ?.split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .join(".");

const owns = (tables: ReadonlyArray<string>, table: string): boolean =>
  tables.some((owned) => table === owned || table.startsWith(`${owned}.`));

/**
 * `text` with the owned tables' sections replaced by `tables`' text, where the first of them
 * was, or at the end. Every line outside those sections is kept as it was.
 */
export const writeTables = (text: string, owned: ReadonlyArray<string>, tables: string): string => {
  const kept: Array<string> = [];
  let at: number | undefined;
  let inOwned = false;
  for (const line of text.split("\n")) {
    const header = headerOf(line);
    if (header !== undefined) inOwned = owns(owned, header);
    if (inOwned) {
      at ??= kept.length;
      continue;
    }
    kept.push(line);
  }
  const block = tables.trimEnd().split("\n");
  if (at === undefined) {
    while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
    return `${[...kept, ...(kept.length === 0 ? [] : [""]), ...block].join("\n")}\n`;
  }
  const before = kept.slice(0, at);
  const after = kept.slice(at);
  while (after.length > 0 && after[0]?.trim() === "") after.shift();
  return `${[...before, ...block, ...(after.length === 0 ? [] : ["", ...after])].join("\n").trimEnd()}\n`;
};

const parseToml = (text: string): unknown => {
  try {
    return Bun.TOML.parse(text);
  } catch {
    return undefined;
  }
};

const at = (value: unknown, dotted: string): unknown =>
  dotted
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        typeof node === "object" && node !== null && Object.hasOwn(node, key)
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );

/** Whether two parsed TOML values are equal, tables compared key by key in any order. */
const same = (a: unknown, b: unknown): boolean => {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => same(item, b[i]))
    );
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every(
        (key) =>
          Object.hasOwn(b, key) &&
          same((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
      )
    );
  }
  return Object.is(a, b);
};

/** How a delivered config stands against what sync would write. */
export type Standing = "current" | "missing" | "diverged" | "unparsable";

export const standing = (delivery: Delivery, current: string | undefined): Standing => {
  if (current === undefined) return "missing";
  if (delivery.delivery === "copy") return current === delivery.text ? "current" : "diverged";
  const have = parseToml(current);
  if (have === undefined) return "unparsable";
  const want = parseToml(delivery.text);
  if (delivery.tables.every((table) => at(have, table) === undefined)) return "missing";
  return delivery.tables.every((table) => same(at(have, table), at(want, table)))
    ? "current"
    : "diverged";
};

/** The shipped files the packs' `copy` configs name, for the adapter to read. */
export const shippedFiles = (packs: ReadonlyArray<Pack>): ReadonlyArray<string> =>
  packs.flatMap((pack) =>
    pack.baseConfigs.flatMap((base) => (base.delivery === "copy" ? [base.shipped] : [])),
  );

/** What sync writes for one delivery, or undefined when it is current or not sync's to fix. */
export const deliver = (delivery: Delivery, current: string | undefined): string | undefined => {
  const now = standing(delivery, current);
  if (now === "current" || now === "unparsable") return undefined;
  return delivery.delivery === "copy"
    ? delivery.text
    : writeTables(current ?? "", delivery.tables, delivery.text);
};
