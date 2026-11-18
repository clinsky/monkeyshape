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
      /** Where a change to an owned table goes instead, as the pack says. */
      readonly override?: (table: string) => string | undefined;
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
            ...(base.override === undefined ? {} : { override: base.override }),
          },
        ];
      const text = shipped.get(base.shipped);
      return text === undefined
        ? []
        : [{ delivery: "copy", pack: pack.id, file: base.target, text }];
    }),
  );

/** A table header, `[a.b]`, or an array-of-tables header, `[[a.b]]`: either ends a section. */
const HEADER = /^\s*\[\[?\s*([^[\]]+?)\s*\]\]?\s*(?:#.*)?$/;

/** The table a `[a.b]` header line opens, unquoted, or undefined for any other line. */
const headerOf = (line: string): string | undefined =>
  // A CRLF file's lines keep their `\r` once split on `\n`; `.` in a comment stops at it.
  HEADER.exec(line.replace(/\r$/, ""))?.[1]
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
  // Written in the file's own line endings: a CRLF file stays CRLF.
  const crlf = text.includes("\r\n");
  const block = tables
    .trimEnd()
    .split("\n")
    .map((line) => (crlf ? `${line}\r` : line));
  const blank = crlf ? "\r" : "";
  const end = (lines: ReadonlyArray<string>) =>
    `${lines.join("\n").trimEnd()}${crlf ? "\r\n" : "\n"}`;
  if (at === undefined) {
    while (kept.length > 0 && kept.at(-1)?.trim() === "") kept.pop();
    return end([...kept, ...(kept.length === 0 ? [] : [blank]), ...block]);
  }
  const before = kept.slice(0, at);
  const after = kept.slice(at);
  while (after.length > 0 && after[0]?.trim() === "") after.shift();
  return end([...before, ...block, ...(after.length === 0 ? [] : [blank, ...after])]);
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
/**
 * `foreign`: an owned table is defined other than by its own `[a.b]` header (dotted keys or an
 * inline table under a parent), which sync can't rewrite without a second definition.
 */
export type Standing =
  | "current"
  | "missing"
  | "diverged"
  | "unparsable"
  | "foreign"
  /** Sync's rewrite would change something outside the owned tables, so it writes nothing. */
  | "unwritable";

/** A copy of a parsed TOML value with each owned table removed. */
const withoutOwned = (value: unknown, tables: ReadonlyArray<string>): unknown => {
  const copy = structuredClone(value);
  for (const table of tables) {
    const path = table.split(".");
    // Delete the table, then each parent it leaves empty: appending `[a.b]` makes `a` too.
    for (let depth = path.length; depth > 0; depth--) {
      const parent = depth === 1 ? copy : at(copy, path.slice(0, depth - 1).join("."));
      if (typeof parent !== "object" || parent === null) break;
      const key = path[depth - 1] ?? "";
      const child = (parent as Record<string, unknown>)[key];
      const empty = typeof child === "object" && child !== null && Object.keys(child).length === 0;
      if (depth !== path.length && !empty) break;
      delete (parent as Record<string, unknown>)[key];
    }
  }
  return copy;
};

/**
 * Whether `written` keeps every value of `current` outside the owned tables and holds the owned
 * ones as sync means them: the guard on any line `writeTables` misreads (a header-like line in
 * a multi-line string), so a rewrite never loses or breaks the rest of the file.
 */
const keepsTheRest = (
  delivery: Extract<Delivery, { delivery: "table" }>,
  current: string,
  written: string,
): boolean => {
  const before = parseToml(current);
  const after = parseToml(written);
  const want = parseToml(delivery.text);
  return (
    before !== undefined &&
    after !== undefined &&
    same(withoutOwned(before, delivery.tables), withoutOwned(after, delivery.tables)) &&
    delivery.tables.every((table) => same(at(after, table), at(want, table)))
  );
};

/** The owned tables `current` defines other than by their own headers. */
export const foreignTables = (delivery: Delivery, current: string): ReadonlyArray<string> => {
  if (delivery.delivery === "copy") return [];
  const rest = parseToml(writeTables(current, delivery.tables, ""));
  return rest === undefined ? [] : delivery.tables.filter((table) => at(rest, table) !== undefined);
};

/** The owned tables whose values differ from what sync writes. */
export const divergedTables = (delivery: Delivery, current: string): ReadonlyArray<string> => {
  if (delivery.delivery === "copy") return [];
  const have = parseToml(current);
  const want = parseToml(delivery.text);
  return delivery.tables.filter((table) => !same(at(have, table), at(want, table)));
};

export const standing = (delivery: Delivery, current: string | undefined): Standing => {
  if (current === undefined) return "missing";
  if (delivery.delivery === "copy") return current === delivery.text ? "current" : "diverged";
  const have = parseToml(current);
  if (have === undefined) return "unparsable";
  if (foreignTables(delivery, current).length > 0) return "foreign";
  const want = parseToml(delivery.text);
  if (delivery.tables.every((table) => same(at(have, table), at(want, table)))) return "current";
  if (!keepsTheRest(delivery, current, writeTables(current, delivery.tables, delivery.text)))
    return "unwritable";
  return delivery.tables.every((table) => at(have, table) === undefined) ? "missing" : "diverged";
};

/** The shipped files the packs' `copy` configs name, for the adapter to read. */
export const shippedFiles = (packs: ReadonlyArray<Pack>): ReadonlyArray<string> =>
  packs.flatMap((pack) =>
    pack.baseConfigs.flatMap((base) => (base.delivery === "copy" ? [base.shipped] : [])),
  );

/** What sync writes for one delivery, or undefined when it is current or not sync's to fix. */
export const deliver = (delivery: Delivery, current: string | undefined): string | undefined => {
  const now = standing(delivery, current);
  if (now !== "missing" && now !== "diverged") return undefined;
  return delivery.delivery === "copy"
    ? delivery.text
    : writeTables(current ?? "", delivery.tables, delivery.text);
};
