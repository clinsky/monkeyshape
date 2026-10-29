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

  test("host globals need hostAccess too: no import is required to reach the host in Bun", () => {
    const source = [
      'const text = await Bun.file("data.json").text();',
      "const cwd = process.cwd();",
      'const response = await fetch("https://x.dev");',
      "Bun.spawn(['ls']);",
    ].join("\n");
    const found = checkArch(layered, repo({ "src/core/b.ts": source }));
    expect(found.map((v) => `${v.rule}:${v.line}`)).toEqual([
      "arch/host-access:1",
      "arch/host-access:2",
      "arch/host-access:3",
      "arch/host-access:4",
    ]);
    expect(rules({ "src/adapters/b.ts": source })).toEqual([]);
  });

  test("a local binding named like a host global shadows it", () => {
    const source = [
      "const process = yield* launcher.spawn(command);",
      "process.kill();",
      "const row = ({ process }: Row) => process.turns;",
      "function run(fetch: Fetcher) { return fetch(url); }",
    ].join("\n");
    expect(rules({ "src/core/b.ts": source })).toEqual([]);
  });

  test("Bun's pure utilities are not host access", () => {
    expect(
      rules({ "src/core/b.ts": 'new Bun.Glob("*.ts").match(p);\nBun.deepEquals(a, b);' }),
    ).toEqual([]);
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
