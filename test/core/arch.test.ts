import { describe, expect, test } from "bun:test";
import { checkArch, moduleOf } from "../../src/core/arch.ts";
import { config, repo } from "../support.ts";

const layered = config({
  arch: {
    modules: {
      schemas: { description: "contracts" },
      core: { description: "logic", mayImport: ["schemas"] },
      adapters: { description: "io", mayImport: ["schemas", "core"], hostAccess: true },
      "adapters/db": {
        description: "database",
        mayImport: ["schemas"],
        hostAccess: true,
        packages: ["pg"],
      },
      cli: {
        description: "entry",
        mayImport: ["core", "adapters"],
        hostAccess: true,
        manifest: true,
      },
    },
  },
});

const rules = (files: Record<string, string>) => checkArch(layered, repo(files)).map((v) => v.rule);

describe("arch", () => {
  test("the longest module key wins", () => {
    const arch = layered.arch;
    if (arch === undefined) return expect(arch).toBeDefined();
    expect(moduleOf(arch, "src/adapters/db/pool.ts")).toBe("adapters/db");
    expect(moduleOf(arch, "src/adapters/fs.ts")).toBe("adapters");
    expect(moduleOf(arch, "src/other/x.ts")).toBeUndefined();
  });

  test("allowed edges pass", () => {
    expect(
      rules({
        "src/schemas/a.ts": "export const a = 1;",
        "src/core/b.ts": 'import { a } from "../schemas/a.ts";\nimport { Effect } from "effect";',
        "src/cli/main.ts":
          'import "../core/b.ts";\nimport pkg from "../../package.json" with { type: "json" };',
      }),
    ).toEqual([]);
  });

  test("an edge not in mayImport fails", () => {
    expect(
      rules({ "src/core/b.ts": 'import "../adapters/x.ts";', "src/adapters/x.ts": "" }),
    ).toEqual(["arch/forbidden-import"]);
  });

  test("type-only imports are edges too", () => {
    expect(
      rules({ "src/core/b.ts": 'import type { X } from "../cli/x.ts";', "src/cli/x.ts": "" }),
    ).toEqual(["arch/forbidden-import"]);
  });

  test("host modules need hostAccess", () => {
    expect(rules({ "src/core/b.ts": 'import { readFile } from "node:fs/promises";' })).toEqual([
      "arch/host-access",
    ]);
    expect(rules({ "src/adapters/b.ts": 'import { readFile } from "node:fs/promises";' })).toEqual(
      [],
    );
  });

  test("third-party packages need an allowlist entry", () => {
    expect(rules({ "src/core/b.ts": 'import pg from "pg";' })).toEqual(["arch/forbidden-package"]);
    expect(rules({ "src/adapters/db/b.ts": 'import pg from "pg/lib";' })).toEqual([]);
  });

  test("files outside every module, unresolved imports and the manifest are reported", () => {
    expect(rules({ "src/misc/x.ts": "" })).toEqual(["arch/unknown-module"]);
    expect(rules({ "src/core/b.ts": 'import "./missing";' })).toEqual(["arch/unresolved-import"]);
    expect(rules({ "src/core/b.ts": 'import pkg from "../../package.json";' })).toEqual([
      "arch/manifest",
    ]);
  });

  test("cycles are reported once, from their first file", () => {
    expect(
      rules({ "src/core/a.ts": 'import "./b.ts";', "src/core/b.ts": 'import "./a.ts";' }),
    ).toEqual(["arch/cycle"]);
  });

  test("a missing module map is itself a violation", () => {
    expect(checkArch(config(), repo({})).map((v) => v.rule)).toEqual(["arch/no-module-map"]);
  });

  test("mayImport naming an unknown module is a config error", () => {
    const bad = config({ arch: { modules: { core: { description: "x", mayImport: ["nope"] } } } });
    expect(checkArch(bad, repo({})).map((v) => v.rule)).toEqual(["arch/config"]);
  });
});
