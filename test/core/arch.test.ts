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

/** What a fixture reports besides modules it has no file for, which most fixtures don't need. */
const rules = (files: Record<string, string>) =>
  checkArch(layered, repo(files))
    .map((v) => v.rule)
    .filter((rule) => rule !== "arch/empty-module");

describe("arch", () => {
  test("a module with no file fails, naming it, unless it is optional", () => {
    const map = (optional: boolean) =>
      config({
        arch: {
          modules: { core: { description: "logic" }, later: { description: "soon", optional } },
        },
      });
    const files = repo({ "src/core/a.ts": "export const a = 1;\n" });
    expect(checkArch(map(false), files).map((v) => v.message)).toEqual([
      expect.stringContaining("module 'later' matches no TypeScript file under src/later/"),
    ]);
    expect(checkArch(map(true), files)).toEqual([]);
  });

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
    const found = checkArch(layered, repo({ "src/core/b.ts": source })).filter(
      (v) => v.rule !== "arch/empty-module",
    );
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

  test("shadowing is lexical: a parameter in one function doesn't hide the global elsewhere", () => {
    const source = [
      "function format(process: string) {",
      "  return process.toUpperCase();",
      "}",
      "export const cwd = process.cwd();",
    ].join("\n");
    const found = checkArch(layered, repo({ "src/core/b.ts": source })).filter(
      (v) => v.rule !== "arch/empty-module",
    );
    expect(found.map((v) => `${v.rule}:${v.line}`)).toEqual(["arch/host-access:4"]);
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

  test("effect stays allowed when allowedPackages lists other packages", () => {
    const listed = config({
      arch: { modules: { core: { description: "logic" } }, allowedPackages: ["zod"] },
    });
    const source = 'import { Effect } from "effect";\nimport { z } from "zod";';
    expect(checkArch(listed, repo({ "src/core/b.ts": source }))).toEqual([]);
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
    expect(checkArch(config(), repo({ "src/a.ts": "" })).map((v) => v.rule)).toEqual([
      "arch/no-module-map",
    ]);
    // With no TypeScript source there is nothing to layer, and arch is not-applicable.
    expect(checkArch(config(), repo({ "README.md": "" }))).toEqual([]);
  });

  test("mayImport naming an unknown module is a config error", () => {
    const bad = config({ arch: { modules: { core: { description: "x", mayImport: ["nope"] } } } });
    expect(checkArch(bad, repo({ "src/core/a.ts": "" })).map((v) => v.rule)).toEqual([
      "arch/config",
    ]);
  });
});

describe("arch at the repo root and across top-level directories", () => {
  const rooted = config({
    sources: { include: ["*.ts", "server/**/*.ts", "lib/**/*.ts", "packages/**/*.ts"] },
    arch: {
      root: ".",
      modules: {
        lib: { description: "shared logic" },
        server: { description: "the service", mayImport: ["lib"], hostAccess: true },
        "packages/api": { description: "the client", mayImport: ["lib"] },
        main: { description: "never matched by a directory" },
      },
    },
  });
  const arch = rooted.arch;

  test("a module names its directory by a path from the root", () => {
    if (arch === undefined) return expect(arch).toBeDefined();
    expect(moduleOf(arch, "server/a.ts")).toBe("server");
    expect(moduleOf(arch, "packages/api/b.ts")).toBe("packages/api");
    expect(moduleOf(arch, "packages/other/c.ts")).toBeUndefined();
    expect(moduleOf(arch, "serverless/d.ts")).toBeUndefined();
  });

  test("finds the real cross-module imports, and fails a forbidden one", () => {
    const files = {
      "lib/util.ts": "export const u = 1;\n",
      "server/a.ts":
        'import { u } from "../lib/util.ts";\nimport { b } from "../packages/api/b.ts";\n',
      "packages/api/b.ts": 'import { u } from "../../lib/util.ts";\nexport const b = u;\n',
    };
    const found = checkArch(rooted, repo(files)).filter((v) => v.rule !== "arch/empty-module");
    expect(found.map((v) => `${v.rule} ${v.file}: ${v.message}`)).toEqual([
      expect.stringMatching(
        /^arch\/forbidden-import server\/a\.ts: module 'server' may not import module 'packages\/api'/,
      ),
    ]);
  });

  test("a root file in no module is reported; tests, declarations, config and exempt files aren't", () => {
    const files = {
      "lib/util.ts": "",
      "index.ts": 'import "./lib/util.ts";\n',
      "tests/a.test.ts": 'import "../server/x.ts";\n',
      "types/g.d.ts": "",
      "shape.config.ts": "",
    };
    expect(
      checkArch(rooted, repo(files))
        .filter((v) => v.rule !== "arch/empty-module")
        .map((v) => `${v.rule} ${v.file}`),
    ).toEqual(["arch/unknown-module index.ts"]);
  });

  test("a map entry matching nothing fails, naming it", () => {
    const files = { "lib/util.ts": "", "server/a.ts": "", "packages/api/b.ts": "" };
    expect(checkArch(rooted, repo(files)).map((v) => v.message)).toEqual([
      expect.stringContaining("module 'main' matches no TypeScript file under main/"),
    ]);
  });

  test("a root written ./, src/ or ./src means the same as . or src", () => {
    for (const [root, include, module, file] of [
      ["./", "server/**/*.ts", "server", "server/a.ts"],
      ["", "server/**/*.ts", "server", "server/a.ts"],
      ["src/", "src/**/*.ts", "core", "src/core/b.ts"],
      ["./src", "src/**/*.ts", "core", "src/core/b.ts"],
    ] as const) {
      const files = repo({ [file]: "" });
      const shape = config({
        sources: { include: [include] },
        arch: { root, modules: { [module]: { description: "m" } } },
      });
      expect([root, checkArch(shape, files).map((v) => v.rule)]).toEqual([root, []]);
    }
  });

  test("a module may name a single file at the root, and is not empty", () => {
    const one = config({
      sources: { include: ["*.ts"] },
      arch: { root: ".", modules: { "harness.ts": { description: "the harness" } } },
    });
    expect(checkArch(one, repo({ "harness.ts": "export const h = 1;\n" }))).toEqual([]);
  });

  test("code in sources but outside arch.root is in no module, so it fails", () => {
    const narrow = config({
      sources: { include: ["src/**/*.ts", "tools/**/*.ts"] },
      arch: { modules: { core: { description: "logic" } } },
    });
    expect(
      checkArch(narrow, repo({ "src/core/a.ts": "", "tools/gen.ts": "" })).map(
        (v) => `${v.rule} ${v.file}`,
      ),
    ).toEqual(["arch/unknown-module tools/gen.ts"]);
  });
});

describe("host access is judged per operation", () => {
  const pure = config({ arch: { modules: { core: { description: "logic" } } } });
  const found = (source: string) =>
    checkArch(pure, repo({ "src/core/a.ts": source })).map((v) => `${v.rule}: ${v.message}`);

  test("passes: pure operations by name, by namespace member, and type-only imports", () => {
    expect(
      found(
        [
          'import { createHash, createHmac } from "node:crypto";',
          'import * as zlib from "node:zlib";',
          'import path from "node:path";',
          'import { Duplex } from "node:stream";',
          'import { Glob } from "bun";',
          'import type { Stats } from "node:fs";',
          'import { type Dirent } from "node:fs";',
          'export const h = createHash("sha256").update("x").digest("hex");',
          "export const z = zlib.inflateRawSync(Buffer.from([]), { flush: zlib.constants.Z_SYNC_FLUSH });",
          'export const p = path.join("a", path.basename("b/c"));',
          "export type S = Stats | Dirent | Duplex | Glob;",
          'export const g = new Glob("*.ts");',
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("fails: a host operation, named in the message", () => {
    expect(found('import { createHash, randomBytes } from "node:crypto";')).toEqual([
      expect.stringMatching(/^arch\/host-access: imports randomBytes from 'node:crypto'/),
    ]);
  });

  test("fails: a namespace used for a host operation, or passed whole", () => {
    expect(
      found(
        [
          'import * as crypto from "node:crypto";',
          'import path from "node:path";',
          'export const h = crypto.createHash("sha256");',
          "export const r = crypto.randomBytes(8);",
          'export const abs = path.resolve("x");',
          "export const all = path;",
        ].join("\n"),
      ),
    ).toEqual([
      expect.stringContaining("uses crypto.randomBytes from 'node:crypto'"),
      expect.stringContaining("uses path.resolve from 'node:path'"),
      expect.stringContaining("uses path from 'node:path'"),
    ]);
  });

  test("fails: a module with nothing pure, a side-effect import, a re-export, a literal dynamic import", () => {
    expect(
      found(
        [
          'import { readFileSync } from "node:fs";',
          'import "node:crypto";',
          'import { spawn } from "bun";',
          'export { join } from "node:path";',
          'export const fs = () => import("node:fs");',
        ].join("\n"),
      ).length,
    ).toBe(5);
  });

  test("fails: a dynamic import computed at runtime, in a module without hostAccess", () => {
    expect(found("export const load = (name: string) => import(name);")).toEqual([
      expect.stringContaining("computed at runtime"),
    ]);
    const host = config({
      arch: { modules: { core: { description: "logic", hostAccess: true } } },
    });
    expect(
      checkArch(host, repo({ "src/core/a.ts": "export const load = (n: string) => import(n);" })),
    ).toEqual([]);
  });
});

describe("host access: #58 review", () => {
  const pure = config({ arch: { modules: { core: { description: "logic" } } } });
  const rulesOf = (source: string) =>
    checkArch(pure, repo({ "src/core/a.ts": source })).map((v) => `${v.rule}:${v.line}`);

  test("fails: a Glob that scans the disk, imported or global, by scan or scanSync", () => {
    for (const source of [
      'import { Glob } from "bun";\nexport const f = () => new Glob("*").scan(".");',
      'import { Glob } from "bun";\nexport const f = () => new Glob("*").scanSync(".");',
      'export const f = () => new Bun.Glob("*").scan(".");',
      'export const f = () => new Bun.Glob("*").scanSync(".");',
    ])
      expect([source, rulesOf(source).length > 0]).toEqual([source, true]);
  });

  test("passes: a Glob that only matches strings, and Bun's hashing and compression", () => {
    expect(
      rulesOf(
        [
          'import { Glob } from "bun";',
          'export const m = (p: string) => new Glob("*.ts").match(p) || new Bun.Glob("*").match(p);',
          'export const h = new Bun.CryptoHasher("sha256").update("x").digest("hex");',
          "export const z = Bun.zstdDecompressSync(Bun.zstdCompressSync(new Uint8Array()));",
          "export const g = Bun.gunzipSync(Bun.gzipSync(new Uint8Array()));",
          "export const d = Bun.inflateSync(Bun.deflateSync(new Uint8Array()));",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("a host namespace exported by name is one finding, not two", () => {
    expect(rulesOf('import * as path from "node:path";\nexport { path };')).toEqual([
      "arch/host-access:2",
    ]);
  });

  test("a root file in no module is told to map the file itself, and that fixes it", () => {
    const at = (modules: Record<string, { description: string }>) =>
      config({ sources: { include: ["*.ts", "lib/**/*.ts"] }, arch: { root: ".", modules } });
    const files = repo({ "harness.ts": "export const h = 1;\n", "lib/a.ts": "" });
    const [found] = checkArch(at({ lib: { description: "l" } }), files);
    expect(found?.message).toContain("'harness.ts'");
    expect(
      checkArch(at({ lib: { description: "l" }, "harness.ts": { description: "h" } }), files),
    ).toEqual([]);
  });
});
