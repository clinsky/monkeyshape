import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { shapeJsonSchema } from "../../src/schemas/config.ts";

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
