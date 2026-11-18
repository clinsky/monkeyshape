/**
 * The Python pack's base configs through `mshape sync`: the copied-configs table for ruff's
 * `.mshape/ruff.toml`, and for ty's `[tool.ty.rules]` the rows its amendment asks for.
 */
import { describe, expect, test } from "bun:test";
import { deliver, deliveries, standing } from "../../../src/core/delivery.ts";
import { checkSync } from "../../../src/core/sync.ts";
import { python } from "../../../src/packs/python/index.ts";
import { CURATED_TY } from "../../../src/packs/python/tyRules.ts";
import {
  type ResolvedConfig,
  resolveConfig,
  type ShapeConfig,
} from "../../../src/schemas/config.ts";
import { listed, repo } from "../../support.ts";

const RUFF = await Bun.file(`${import.meta.dir}/../../../config/python/ruff.toml`).text();
const SHIPPED = new Map([["config/python/ruff.toml", RUFF]]);

const config = (input: ShapeConfig = {}): ResolvedConfig =>
  resolveConfig({ packs: ["python"], ...input }, "shape.toml", [], {
    python: python.defaultSources.include,
  });

const PYPROJECT = `[project]
name = "app"
version = "0.1.0"

[tool.ruff]
extend = ".mshape/ruff.toml"
`;

const delivery = (kind: "copy" | "table", input?: ShapeConfig) => {
  const found = deliveries(config(input), [python], SHIPPED).find((d) => d.delivery === kind);
  if (found === undefined) throw new Error(`no ${kind} delivery`);
  return found;
};

/** The sync check's findings for `files`, with sync otherwise in place. */
const sync = (files: Readonly<Record<string, string>>, input?: ShapeConfig) =>
  checkSync(
    config(input),
    repo(files, {
      packs: [listed(python)],
      skills: {
        link: { kind: "missing" },
        installed: new Map([["monkeyshape.json", new TextEncoder().encode('{"shared":[]}')]]),
        claudeDirectory: new Map(),
        shipped: new Map(),
      },
      shippedConfigs: Object.fromEntries(SHIPPED),
    }),
  )
    .filter((v) => v.rule.startsWith("sync/base-"))
    .map((v) => [v.rule, v.file, v.message]);

describe("ruff's curated config, copied to .mshape/ruff.toml", () => {
  test("missing: sync writes the shipped text; equal: current; edited by hand: diverged", () => {
    const copy = delivery("copy");
    expect(copy.file).toBe(".mshape/ruff.toml");
    expect(deliver(copy, undefined)).toBe(RUFF);
    expect(standing(copy, RUFF)).toBe("current");
    expect(standing(copy, RUFF.replace('"T20",', ""))).toBe("diverged");
  });
});

describe("ty's curated rules, a table sync owns in pyproject.toml", () => {
  const written = deliver(delivery("table"), PYPROJECT) ?? "";

  test("sync writes [tool.ty.rules] and keeps every other line of pyproject.toml", () => {
    expect(written.startsWith(PYPROJECT)).toBe(true);
    expect((Bun.TOML.parse(written) as { tool: { ty: { rules: object } } }).tool.ty.rules).toEqual(
      CURATED_TY,
    );
    expect(standing(delivery("table"), written)).toBe("current");
  });

  test("a reformat passes: the table compared by value, not text", () => {
    const [head, table = ""] = written.split("[tool.ty.rules]\n");
    const reordered = table.trimEnd().split("\n").reverse().join("\n").replaceAll(" = ", "=");
    expect(standing(delivery("table"), `${head}[tool.ty.rules]\n${reordered}\n`)).toBe("current");
  });

  test("a hand edit fails, naming [python.ty-rules] in shape.toml as where it goes", () => {
    const edited = written.replace('redundant-cast = "error"', 'redundant-cast = "warn"');
    expect(edited).not.toBe(written);
    expect(standing(delivery("table"), edited)).toBe("diverged");
    const files = { "pyproject.toml": edited, ".mshape/ruff.toml": RUFF };
    expect(sync(files)).toEqual([
      [
        "sync/base-diverged",
        "pyproject.toml",
        expect.stringContaining("Make the change in `[python.ty-rules]` in shape.toml instead"),
      ],
    ]);
    // With the copy current and the table as sync writes it, the check is clean.
    expect(sync({ "pyproject.toml": written, ".mshape/ruff.toml": RUFF })).toEqual([]);
  });

  test("an override in [python.ty-rules] wins: the edit made there is current", () => {
    const edited = written.replace('redundant-cast = "error"', 'redundant-cast = "warn"');
    const overridden = { python: { tyRules: { "redundant-cast": "warn" as const } } };
    expect(standing(delivery("table", overridden), edited)).toBe("current");
    expect(standing(delivery("table", overridden), written)).toBe("diverged");
  });
});
