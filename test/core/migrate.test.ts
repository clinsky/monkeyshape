import { describe, expect, test } from "bun:test";
import { computedKeys, toToml } from "../../src/core/migrate.ts";

describe("toToml", () => {
  test("plain values first, then each table; a table with only subtables has no header", () => {
    expect(
      toToml({
        packs: ["typescript"],
        arch: { modules: { core: { description: "Pure.", "may-import": ["schemas"] } } },
        rules: { "no-throw": { off: "a reason" } },
      }),
    ).toBe(
      [
        'packs = ["typescript"]',
        "",
        "[arch.modules.core]",
        'description = "Pure."',
        'may-import = ["schemas"]',
        "",
        "[rules.no-throw]",
        'off = "a reason"',
        "",
      ].join("\n"),
    );
  });

  test("keys TOML can't take bare are quoted; tables in a list are inline, one per line", () => {
    const text = toToml({
      arch: { modules: { "odd.name": { description: "x" } } },
      sources: { exempt: [{ path: "a/**", reason: 'says "why"' }] },
    });
    expect(text).toContain('[arch.modules."odd.name"]');
    expect(text).toContain('exempt = [\n  { path = "a/**", reason = "says \\"why\\"" },\n]');
    expect(Bun.TOML.parse(text)).toEqual({
      arch: { modules: { "odd.name": { description: "x" } } },
      sources: { exempt: [{ path: "a/**", reason: 'says "why"' }] },
    });
  });

  test("{ add } reads as one value; an empty table is dropped", () => {
    const text = toToml({ refs: { docs: { add: ["x.md"] } }, coverage: {} });
    expect(text).toBe('[refs]\ndocs = { add = ["x.md"] }\n');
  });
});

describe("computedKeys", () => {
  test("the deepest key whose value isn't written out, through defineConfig(…) or a bare object", () => {
    const source = `import { defineConfig } from "monkeyshape";
const N = 3;
export default defineConfig({
  budgets: { agentsLines: N, readmeLines: 90 },
  refs: { docs: [...BASE, "x.md"] },
  arch: { modules: { core: { description: \`plain\`, mayImport: ["a"] } } },
  files: { maxBytes: -1 },
});
`;
    expect(computedKeys(source)).toEqual([
      ["budgets", "agentsLines"],
      ["refs", "docs"],
    ]);
    expect(computedKeys("export default { beads: 'required' };\n")).toEqual([]);
  });

  test("a config that isn't an object literal: the whole of it is computed", () => {
    expect(computedKeys("const c = { beads: 'required' };\nexport default c;\n")).toEqual([[]]);
  });
});
