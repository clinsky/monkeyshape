import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { decodeStrictSync } from "../../src/helpers/decodeStrict.ts";
import { ShapeToml, shapeJsonSchema } from "../../src/schemas/config.ts";

const SHIPPED = join(import.meta.dir, "..", "..", "schema", "shape.schema.json");

/** Every object in the schema with named properties, and those names. */
const objects = (node: unknown, found: Array<Record<string, unknown>> = []) => {
  if (Array.isArray(node)) for (const item of node) objects(item, found);
  else if (typeof node === "object" && node !== null) {
    const record = node as Record<string, unknown>;
    if (typeof record["properties"] === "object") found.push(record);
    for (const value of Object.values(record)) objects(value, found);
  }
  return found;
};

describe("schema/shape.schema.json", () => {
  test("is what the schema generates: `bun run schema` rewrites it", async () => {
    expect(await Bun.file(SHIPPED).text()).toBe(shapeJsonSchema());
  });

  test("refuses unknown keys, as the loader does, and names every key in kebab-case", () => {
    const found = objects(JSON.parse(shapeJsonSchema()));
    expect(found.length).toBeGreaterThan(10);
    for (const object of found) {
      expect(object["additionalProperties"]).toBe(false);
      for (const key of Object.keys(object["properties"] as object))
        expect(key).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  });
});

/**
 * Documents the editor's schema and the loader must judge alike: whatever one refuses, so
 * does the other. Cross-key problems (a module's pack, a stage named twice) are the loader's
 * alone and are tested with it.
 */
const CORPUS: ReadonlyArray<readonly [string, boolean, string]> = [
  ["minimal", true, 'packs = ["typescript"]'],
  ["a reason of 8", true, '[sources]\nexempt = [{ path = "x", reason = "12345678" }]'],
  [
    "a reason of 8 code points",
    true,
    '[sources]\nexempt = [{ path = "x", reason = "日本語の理由です" }]',
  ],
  ["a short reason", false, '[sources]\nexempt = [{ path = "x", reason = "short" }]'],
  ["a pin", true, `[mshape]\nversion = "0.6.0-rc.1"\nsums = "${"a".repeat(64)}"`],
  ["a version that isn't one", false, '[mshape]\nversion = "latest"'],
  ["sums that aren't a sha256", false, '[mshape]\nversion = "0.6.0"\nsums = "XYZ"'],
  ["no version", false, '[mshape]\ndev = ["bun", "src/cli/main.ts"]'],
  [
    "a vendored record",
    true,
    `[[files.vendored]]\npath = "vendor/a.tgz"\npackage = "a"\nsha256 = "${"0".repeat(64)}"`,
  ],
  [
    "a vendored path outside the repo",
    false,
    `[[files.vendored]]\npath = "../a.tgz"\npackage = "a"\nsha256 = "${"0".repeat(64)}"`,
  ],
  [
    "a bad digest",
    false,
    '[[files.vendored]]\npath = "vendor/a.tgz"\npackage = "a"\nsha256 = "XYZ"',
  ],
  ["a shared path", true, '[tracks]\nshared-paths = ["data/large"]'],
  ["a shared path with ./", false, '[tracks]\nshared-paths = ["./data"]'],
  ["a stage", true, '[[gate.stages]]\nname = "x"\nrun = ["a"]\nok-exit = [0, 5]'],
  ["a stage with no argv", false, '[[gate.stages]]\nname = "x"\nrun = []'],
  ["a stage with no name", false, '[[gate.stages]]\nname = ""\nrun = ["a"]'],
  ["an unknown pack", false, 'packs = ["cobol"]'],
  ["no packs listed", false, "packs = []"],
  ["an unknown key", false, "pakcs = 1"],
  ["a camelCase key", false, "[budgets]\nagentsLines = 1"],
  ["a module", true, '[arch.modules.core]\ndescription = "x"\nmay-import = ["a"]\npack = "rust"'],
  ["a rule turned off", true, '[rules."no-throw"]\noff = "a reason long enough"'],
  ["a refs kind", true, '[refs.rules.missing-path]\noff = "a reason long enough"'],
  ["an unknown refs kind", false, '[refs.rules.nope]\noff = "a reason long enough"'],
];

describe("the shipped schema and the loader", () => {
  const validate = new Ajv2020({ allErrors: true }).compile(JSON.parse(shapeJsonSchema()));
  const loads = (document: unknown): boolean => {
    try {
      decodeStrictSync(ShapeToml)(document);
      return true;
    } catch {
      return false;
    }
  };

  for (const [name, valid, text] of CORPUS)
    test(`${valid ? "both accept" : "both refuse"} ${name}`, () => {
      const document: unknown = Bun.TOML.parse(text);
      expect({ loader: loads(document), schema: validate(document) }).toEqual({
        loader: valid,
        schema: valid,
      });
    });

  test("both accept this repo's shape.toml", async () => {
    const document: unknown = Bun.TOML.parse(
      await Bun.file(join(import.meta.dir, "..", "..", "shape.toml")).text(),
    );
    expect({ loader: loads(document), schema: validate(document) }).toEqual({
      loader: true,
      schema: true,
    });
  });
});
