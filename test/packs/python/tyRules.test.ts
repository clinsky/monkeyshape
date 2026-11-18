import { describe, expect, test } from "bun:test";
import { python } from "../../../src/packs/python/index.ts";
import { CURATED_TY, effectiveTyRules, renderTyRules } from "../../../src/packs/python/tyRules.ts";
import { resolveConfig } from "../../../src/schemas/config.ts";

const table = () => {
  const base = python.baseConfigs.find((config) => config.delivery === "table");
  if (base?.delivery !== "table") throw new Error("the Python pack has no table");
  return base;
};

describe("the curated ty rules as the table sync owns", () => {
  test("[tool.ty.rules] in pyproject.toml, every curated rule an error, in name order", () => {
    const base = table();
    expect([base.file, base.tables]).toEqual(["pyproject.toml", ["tool.ty.rules"]]);
    const text = base.content(resolveConfig({ packs: ["python"] }, "shape.toml"));
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("[tool.ty.rules]");
    expect(lines.slice(1)).toEqual([...lines.slice(1)].sort());
    expect(lines).toHaveLength(Object.keys(CURATED_TY).length + 1);
    expect(Bun.TOML.parse(text)).toEqual({ tool: { ty: { rules: CURATED_TY } } });
  });

  test("an override in [python.ty-rules] wins, rule by rule, and may add a rule", () => {
    const config = resolveConfig(
      {
        packs: ["python"],
        python: { tyRules: { "redundant-cast": "warn", "unsound-return": "error" } },
      },
      "shape.toml",
    );
    const rules = (Bun.TOML.parse(table().content(config)) as { tool: { ty: { rules: object } } })
      .tool.ty.rules;
    expect(rules).toEqual({
      ...CURATED_TY,
      "redundant-cast": "warn",
      "unsound-return": "error",
    });
  });

  test("rendering is stable for the same rules", () => {
    expect(renderTyRules(effectiveTyRules({}))).toBe(renderTyRules(effectiveTyRules(undefined)));
  });
});
