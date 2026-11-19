import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { importTsConfig, loadConfig } from "../../src/adapters/config.ts";
import { migrateConfig } from "../../src/adapters/migrate.ts";
import { DEFAULT_DOCS, resolveConfig } from "../../src/schemas/config.ts";
import { ConfigError } from "../../src/schemas/errors.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-migrate-test-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PIN = { version: "0.6.0" };
const migrate = () => Effect.runPromise(migrateConfig(dir, PIN));
const old = (text: string) => Bun.write(join(dir, "shape.config.ts"), text);
const has = (file: string) => Bun.file(join(dir, file)).exists();

/** What a config resolves to, with where it came from set aside. */
const resolved = (config: ReturnType<typeof resolveConfig>) => ({
  ...config,
  configFile: "",
  configModules: [],
  packs: [],
  mshape: undefined,
});

/** A config of plain values, touching most keys, with reasons that need escaping. */
const PLAIN = `export default {
  sources: { exempt: [{ path: "template/**", reason: "scaffold data that \`mshape init\` copies" }] },
  entry: ["src/cli/**"],
  arch: {
    root: "src",
    modules: {
      core: { description: "Pure.", mayImport: ["schemas"], packages: ["oxc-parser"] },
      "odd.name": { description: "A module named with a dot.", hostAccess: true, optional: true },
      schemas: { description: "Data contracts." },
    },
    allowedPackages: ["zod"],
  },
  rules: { "no-throw": { allow: [{ path: "src/x.ts", reason: 'a reason with "quotes", a \\\\ and é' }] } },
  checks: { beads: { off: "this repo has no beads yet" } },
  beads: "required",
  tracks: { sharedPaths: ["data/large"] },
  budgets: { agentsLines: 160, largeFiles: [{ path: "big.md", reason: "a long reference doc" }] },
  files: { maxBytes: 2048 },
  coverage: { exemptFiles: [{ path: "bin/tool", reason: "a vendored release" }] },
  prerequisites: { biome: "optional" },
};
`;

/** The plan's migrate table, one test per row. */
describe("mshape config migrate", () => {
  test("a config of plain values: shape.toml written, resolving to the same config", async () => {
    await old(PLAIN);
    const before = await Effect.runPromise(
      importTsConfig(dir, join(dir, "shape.config.ts"), "shape.config.ts"),
    );
    const result = await migrate();
    expect(result.code).toBe(0);
    expect(result.lines[0]).toBe(
      "wrote shape.toml from shape.config.ts, and deleted shape.config.ts",
    );
    expect(await has("shape.config.ts")).toBe(false);
    const after = await Effect.runPromise(loadConfig(dir));
    expect(after.configFile).toBe("shape.toml");
    expect(after.packs).toEqual(["typescript"]);
    expect(after.mshape?.version).toBe("0.6.0");
    expect(resolved(after)).toEqual(resolved(resolveConfig(before, "shape.config.ts")));
    // Plain values need no note.
    expect(result.lines.filter((line) => line.startsWith("note:"))).toEqual([]);
  });

  test("localRules set, rules not yet ported: refuses, naming each and docs/local-rules.md", async () => {
    await old(
      'export default { localRules: [{ id: "index-writes" }, { id: "no-raw-sql" }, { id: "ported-one" }] };\n',
    );
    await Bun.write(join(dir, "shape-rules", "ported-one.yml"), "id: ported-one\n");
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain(
      "not yet ported to shape-rules/: index-writes, no-raw-sql.",
    );
    expect(result.lines.join("\n")).toContain("docs/local-rules.md");
    expect(await has("shape.config.ts")).toBe(true);
    expect(await has("shape.toml")).toBe(false);
  });

  test("localRules set, each id present under shape-rules/: writes the config without them", async () => {
    await old('export default { localRules: [{ id: "index-writes" }], beads: "required" };\n');
    await Bun.write(join(dir, "shape-rules", "index-writes.yml"), "id: index-writes\n");
    const result = await migrate();
    expect(result.code).toBe(0);
    const text = await Bun.file(join(dir, "shape.toml")).text();
    expect(text).not.toContain("local");
    expect(text).toContain('beads = "required"');
    expect(result.lines.join("\n")).toContain(
      "note: localRules: not written; index-writes run from shape-rules/",
    );
  });

  test("values computed in code: written as their resolved values, with a note per key", async () => {
    await Bun.write(
      join(dir, "shared.ts"),
      'export const LIMIT = 140;\nexport const MORE = ["docs/guide.md"];\n',
    );
    await old(
      `import { LIMIT, MORE } from "./shared.ts";
const DOCS = ${JSON.stringify(DEFAULT_DOCS)};
export default {
  budgets: { agentsLines: LIMIT, readmeLines: 90 },
  refs: { docs: [...DOCS, ...MORE] },
  tracks: { sharedPaths: ["data/" + "large"] },
};
`,
    );
    const result = await migrate();
    expect(result.code).toBe(0);
    const text = await Bun.file(join(dir, "shape.toml")).text();
    expect(text).toContain("agents-lines = 140");
    expect(text).toContain('docs = { add = ["docs/guide.md"] }');
    expect(text).toContain('shared-paths = ["data/large"]');
    const notes = result.lines.filter((line) => line.startsWith("note:"));
    expect(notes).toEqual([
      "note: budgets.agents-lines: computed in code; written as the value it evaluated to",
      "note: refs.docs: computed in code; written as `{ add = [...] }`, the entries after the default, so it keeps following the default",
      "note: tracks.shared-paths: computed in code; written as the value it evaluated to",
    ]);
    expect((await Effect.runPromise(loadConfig(dir))).refs.docs).toEqual([
      ...DEFAULT_DOCS,
      "docs/guide.md",
    ]);
  });

  test("an allowance's reason: kept verbatim", async () => {
    await old(PLAIN);
    await migrate();
    const config = await Effect.runPromise(loadConfig(dir));
    expect(config.rules["no-throw"]?.allow?.[0]?.reason).toBe('a reason with "quotes", a \\ and é');
    expect(config.sources.exempt[0]?.reason).toBe("scaffold data that `mshape init` copies");
  });

  test("shape.toml already present: refuses, already migrated", async () => {
    await old(PLAIN);
    await Bun.write(join(dir, "shape.toml"), 'packs = ["typescript"]\n');
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("shape.toml is already here, so this repo is migrated");
    expect(await Bun.file(join(dir, "shape.toml")).text()).toBe('packs = ["typescript"]\n');
  });

  test("run twice after success: refuses, as above", async () => {
    await old(PLAIN);
    expect((await migrate()).code).toBe(0);
    const written = await Bun.file(join(dir, "shape.toml")).text();
    const again = await migrate();
    expect(again.code).toBe(1);
    expect(again.lines[0]).toContain("already here, so this repo is migrated");
    expect(await Bun.file(join(dir, "shape.toml")).text()).toBe(written);
  });

  test("an old config that doesn't load today: refused with its reason, nothing changed", async () => {
    // It decodes, but names a tool no listed pack has: the loader refuses it today.
    await old('export default { prerequisites: { rustc: "optional" } };\n');
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("shape.config.ts doesn't load today (");
    expect(result.lines[0]).toContain("prerequisites.rustc");
    expect(await has("shape.config.ts")).toBe(true);
    expect(await has("shape.toml")).toBe(false);
  });

  test("the shape.toml it wrote doesn't load: shape.config.ts stays, and no shape.toml is left", async () => {
    await old(PLAIN);
    // A loader that takes the old config and refuses the new one, as a bug in migrate would.
    const load: typeof loadConfig = (root, given) =>
      given?.endsWith(".toml")
        ? Effect.fail(new ConfigError({ path: "shape.toml", reason: "refused for the test" }))
        : loadConfig(root, given);
    const result = await Effect.runPromise(migrateConfig(dir, PIN, load));
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("doesn't load (shape.toml: refused for the test)");
    expect(await Bun.file(join(dir, "shape.config.ts")).text()).toBe(PLAIN);
    expect(await has("shape.toml")).toBe(false);
  });

  test("the pin is the monkeyshape node_modules holds, so mshape and its imports are one version", async () => {
    await old('export default { beads: "required" };\n');
    await Bun.write(
      join(dir, "node_modules", "monkeyshape", "package.json"),
      JSON.stringify({ name: "monkeyshape", version: "0.4.0" }),
    );
    expect((await migrate()).code).toBe(0);
    expect((await Effect.runPromise(loadConfig(dir))).mshape?.version).toBe("0.4.0");
  });

  test("docs that name shape.config.ts are listed, since it is gone", async () => {
    await old('export default { beads: "required" };\n');
    await Bun.write(join(dir, "AGENTS.md"), "The config is `shape.config.ts`.\n");
    await Bun.write(join(dir, "README.md"), "Nothing about it.\n");
    const result = await migrate();
    expect(result.lines).toContain(
      "note: AGENTS.md names shape.config.ts, which is gone: say shape.toml there (refs/missing-path flags each until then)",
    );
  });

  test("no shape.config.ts: refuses, saying where a config comes from", async () => {
    const result = await migrate();
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("there is no shape.config.ts here to migrate");
  });
});
