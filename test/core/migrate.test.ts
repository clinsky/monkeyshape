import { describe, expect, test } from "bun:test";
import { computedKeys, planMigration, toToml } from "../../src/core/migrate.ts";
import { DEFAULT_COVERAGE_EXEMPT, type ShapeConfig } from "../../src/schemas/config.ts";

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

  test("{ add } reads as one value; an empty table keeps its header, since it says something (#132's review)", () => {
    expect(toToml({ refs: { docs: { add: ["x.md"] } } })).toBe(
      '[refs]\ndocs = { add = ["x.md"] }\n',
    );
    const text = toToml({ arch: { modules: {} } });
    expect(text).toBe("[arch.modules]\n");
    expect(Bun.TOML.parse(text)).toEqual({ arch: { modules: {} } });
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
      { path: ["budgets", "agentsLines"], kind: "value" },
      { path: ["refs", "docs"], kind: "value" },
    ]);
    expect(computedKeys("export default { beads: 'required' };\n")).toEqual([]);
  });

  test("a config that isn't an object literal: the whole of it is computed", () => {
    expect(computedKeys("const c = { beads: 'required' };\nexport default c;\n")).toEqual([
      { path: [], kind: "whole" },
    ]);
  });
});

describe("planMigration's notes and tables (#132's review)", () => {
  const plan = (config: ShapeConfig, source: string) =>
    planMigration({ config, source, ruleIds: [], ported: new Set(), pin: { version: "0.6.0" } });

  test("a spread or computed key names the object it is in, not the whole config", () => {
    const top = plan(
      { beads: "required" },
      'const shared = {};\nexport default { ...shared, beads: "required" };\n',
    );
    expect("notes" in top && top.notes).toEqual([
      "the top level spreads or computes keys: each is written as the value it evaluated to",
    ]);
    const nested = plan(
      { arch: { modules: { core: { description: "Pure." } } } },
      'const m = {};\nexport default { arch: { modules: { ...m, core: { description: "Pure." } } } };\n',
    );
    expect("notes" in nested && nested.notes).toEqual([
      "arch.modules spreads or computes keys: each is written as the value it evaluated to",
    ]);
  });

  test("arch = { modules = {} } is kept, so arch resolves as the same empty map", () => {
    const written = plan({ arch: { modules: {} } }, "export default { arch: { modules: {} } };\n");
    expect("toml" in written && written.toml).toContain("[arch.modules]\n");
  });

  test("a table that held only a default list is dropped with it", () => {
    const written = plan(
      { coverage: { exempt: [...DEFAULT_COVERAGE_EXEMPT] } },
      "export default { coverage: { exempt: [] } };\n",
    );
    expect("toml" in written && written.toml).not.toContain("[coverage]");
  });
});
