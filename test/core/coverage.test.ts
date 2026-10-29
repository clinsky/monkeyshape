import { describe, expect, test } from "bun:test";
import { biomeCovers, checkCoverage, tsconfigCovers } from "../../src/core/coverage.ts";
import { stripJsonc } from "../../src/core/jsonc.ts";
import { config, repo } from "../support.ts";

const configs = (tsconfig: object, biome: object) => ({
  "tsconfig.json": JSON.stringify(tsconfig),
  "biome.json": JSON.stringify(biome),
});

const rules = (files: Record<string, string>) =>
  checkCoverage(config(), repo(files)).map((v) => `${v.rule} ${v.file}`);

describe("coverage", () => {
  test("every TypeScript file is typechecked and linted", () => {
    const files = {
      ...configs({ include: ["src"] }, { files: { includes: ["src/**"] } }),
      "src/a.ts": "",
    };
    expect(rules(files)).toEqual([]);
  });

  test("an excluded script is reported by both tools", () => {
    const files = {
      ...configs(
        { include: ["src", "scripts"], exclude: ["scripts/old.ts"] },
        { files: { includes: ["src/**"] } },
      ),
      "scripts/old.ts": "",
    };
    expect(rules(files)).toEqual([
      "coverage/typecheck scripts/old.ts",
      "coverage/lint scripts/old.ts",
    ]);
  });

  test("generated and vendored segments are exempt", () => {
    const files = {
      ...configs({ include: ["src"] }, { files: { includes: ["src/**"] } }),
      "vendor/x/y.ts": "",
    };
    expect(rules(files)).toEqual([]);
  });

  test("missing or invalid configs are reported once, not once per file", () => {
    expect(rules({ "tsconfig.json": "{", "src/a.ts": "" })).toEqual([
      "coverage/config tsconfig.json",
      "coverage/config biome.json",
    ]);
  });

  test("tsconfig semantics: directories, globs, files, nested projects", () => {
    expect(tsconfigCovers("tsconfig.json", { include: ["src"] }, "src/deep/a.ts")).toBe(true);
    expect(tsconfigCovers("tsconfig.json", { include: ["src/**/*"] }, "src/a.ts")).toBe(true);
    expect(tsconfigCovers("tsconfig.json", {}, "anything.ts")).toBe(true);
    expect(tsconfigCovers("tsconfig.json", { files: ["a.ts"] }, "b.ts")).toBe(false);
    expect(tsconfigCovers("ui/tsconfig.json", { include: ["src"] }, "ui/src/a.tsx")).toBe(true);
    expect(tsconfigCovers("ui/tsconfig.json", { include: ["src"] }, "src/a.ts")).toBe(false);
  });

  test("biome includes are ordered: a later pattern overrides an earlier one", () => {
    const biome = { files: { includes: ["**", "!scripts", "scripts/keep.ts"] } };
    expect(biomeCovers(biome, "src/a.ts")).toBe(true);
    expect(biomeCovers(biome, "scripts/old.ts")).toBe(false);
    expect(biomeCovers(biome, "scripts/keep.ts")).toBe(true);
    expect(biomeCovers({}, "x.ts")).toBe(true);
  });

  test("JSONC: comments and trailing commas, but not inside strings", () => {
    const text = '{\n  // c\n  "a": "x // y", /* b */\n  "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: "x // y", b: [1, 2] });
  });
});
