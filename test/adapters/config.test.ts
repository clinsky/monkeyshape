import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { loadConfig } from "../../src/adapters/config.ts";
import { PACKS } from "../../src/packs/index.ts";
import { PACK_IDS } from "../../src/schemas/config.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("a module the config imports that doesn't parse is named, with its line", async () => {
    // An adopter rule, imported and listed by the config, with a syntax error.
    await Bun.write(join(dir, "rules", "broken.ts"), "export default { a: ;\n");
    await Bun.write(
      join(dir, "shape.config.ts"),
      'import broken from "./rules/broken.ts";\nexport default { localRules: [broken] };\n',
    );
    const error = await Effect.runPromise(Effect.flip(loadConfig(dir)));
    expect(error.message).toContain(`${join(dir, "rules", "broken.ts")}:1:`);
    expect(error.message).toContain("Unexpected");
  });

  test("the loaded config is named as the reader named it", async () => {
    await Bun.write(join(dir, "shape.config.ts"), "export default {};\n");
    await Bun.write(join(dir, "trial", "try.ts"), "export default {};\n");
    expect((await Effect.runPromise(loadConfig(dir))).configFile).toBe("shape.config.ts");
    expect(
      (await Effect.runPromise(loadConfig(dir, join(dir, "trial", "try.ts")))).configFile,
    ).toBe("trial/try.ts");
  });

  test("the repo files the config reaches by relative import are its own; packages aren't", async () => {
    await Bun.write(join(dir, "rules", "helper.ts"), "export const x = 1;\n");
    await Bun.write(
      join(dir, "rules", "a.ts"),
      'import { x } from "./helper.ts";\nexport default { x };\n',
    );
    await Bun.write(
      join(dir, "shape.config.ts"),
      'import a from "./rules/a.ts";\nexport default { sources: { include: [String(Boolean(a))] } };\n',
    );
    expect((await Effect.runPromise(loadConfig(dir))).configModules).toEqual([
      "rules/a.ts",
      "rules/helper.ts",
    ]);
  });

  test("names the file it tried: --config's path, not shape.config.ts", async () => {
    const given = await Effect.runPromise(Effect.flip(loadConfig(dir, join(dir, "nope.ts"))));
    expect(given.message).toBe("nope.ts: not found");
    const own = await Effect.runPromise(Effect.flip(loadConfig(dir)));
    expect(own.message).toBe("shape.toml: not found; every adopting repo has one");
    const outside = await Effect.runPromise(Effect.flip(loadConfig(dir, "/nowhere/x.ts")));
    expect(outside.message).toBe("/nowhere/x.ts: not found");
  });

  test("a config outside the repo resolves monkeyshape from the repo, and its own files beside it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "mshape-outside-"));
    try {
      await Bun.write(join(outside, "shared.ts"), 'export const docs = ["AGENTS.md"];\n');
      await Bun.write(
        join(outside, "try.config.ts"),
        'import { defineConfig } from "monkeyshape";\nimport { docs } from "./shared.ts";\nexport default defineConfig({ refs: { docs }, files: { vendored: [{ path: "vendor/m.tgz", package: "monkeyshape", sha256: "' +
          "a".repeat(64) +
          '" }] } });\n',
      );
      const config = await Effect.runPromise(loadConfig(dir, join(outside, "try.config.ts")));
      expect(config.refs.docs).toEqual(["AGENTS.md"]);
      // Findings about the config point at the file loaded, not the repo's shape.config.ts.
      expect(config.configFile).toBe(join(outside, "try.config.ts"));
      // A string equal to an import's specifier, outside an import, is data: left as written.
      expect(config.files.vendored[0]?.package).toBe("monkeyshape");
      // An error names the file given, not the copy loaded.
      await Bun.write(join(outside, "bad.config.ts"), "export default { a: ;\n");
      const error = await Effect.runPromise(
        Effect.flip(loadConfig(dir, join(outside, "bad.config.ts"))),
      );
      expect(error.message).toContain(`${join(outside, "bad.config.ts")}:1:`);
      expect(error.message).not.toContain("mshape-config-");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("modules an outside config reaches by relative import resolve monkeyshape from the repo too", async () => {
    // As with an adopter rule beside a trial config: the rule module imports monkeyshape.
    const outside = await mkdtemp(join(tmpdir(), "mshape-outside-"));
    try {
      await Bun.write(
        join(outside, "rules", "deep.ts"),
        'import { decodeStrict } from "monkeyshape";\nexport const deep = typeof decodeStrict;\n',
      );
      await Bun.write(
        join(outside, "rules", "docs.ts"),
        'import { defineConfig } from "monkeyshape";\nimport { deep } from "./deep";\nexport const docs = [typeof defineConfig + "-" + deep + ".md"];\n',
      );
      await Bun.write(
        join(outside, "try.config.ts"),
        'import { defineConfig } from "monkeyshape";\nimport { docs } from "./rules/docs.ts";\nexport default defineConfig({ refs: { docs } });\n',
      );
      const config = await Effect.runPromise(loadConfig(dir, join(outside, "try.config.ts")));
      expect(config.refs.docs).toEqual(["function-function.md"]);
      // An error in a reached module names that module, not its copy.
      await Bun.write(join(outside, "rules", "deep.ts"), "export const deep = ;\n");
      const error = await Effect.runPromise(
        Effect.flip(loadConfig(dir, join(outside, "try.config.ts"))),
      );
      expect(error.message).toContain(join(outside, "rules", "deep.ts"));
      expect(error.message).not.toContain("mshape-config-");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

/** The plan's `shape.toml` case table, one test per row. */
describe("shape.toml", () => {
  const write = (text: string) => Bun.write(join(dir, "shape.toml"), text);
  const fails = async () => (await Effect.runPromise(Effect.flip(loadConfig(dir)))).message;

  test("shape.toml only: read, its kebab-case keys into the resolved config", async () => {
    await write(
      [
        'packs = ["typescript"]',
        "[arch.modules.core]",
        'description = "Pure checks."',
        'may-import = ["schemas"]',
        "host-access = false",
        "[budgets]",
        "agents-lines = 120",
        "[tracks]",
        'shared-paths = ["data/large"]',
        "[[gate.stages]]",
        'name = "native"',
        'run = ["make", "check"]',
        "ok-exit = [0, 5]",
        "",
      ].join("\n"),
    );
    const config = await Effect.runPromise(loadConfig(dir));
    expect(config.configFile).toBe("shape.toml");
    expect(config.packs).toEqual(["typescript"]);
    expect(config.arch?.modules["core"]).toEqual({
      description: "Pure checks.",
      mayImport: ["schemas"],
      hostAccess: false,
    });
    expect(config.budgets.agentsLines).toBe(120);
    expect(config.tracks.sharedPaths).toEqual(["data/large"]);
    expect(config.gate.stages).toEqual([
      { name: "native", run: ["make", "check"], okExit: [0, 5] },
    ]);
  });

  test("shape.toml only: a value the schema rejects fails with its key path and the reason", async () => {
    await write('packs = ["typescript"]\n[files]\nmax-bytes = "big"\n');
    const message = await fails();
    expect(message).toContain("shape.toml");
    expect(message).toContain('["files"]["max-bytes"]');
    expect(message).toContain("Expected number");
  });

  test("shape.toml that isn't TOML fails, saying so", async () => {
    await write("packs = [\n");
    expect(await fails()).toStartWith("shape.toml: isn't valid TOML:");
  });

  test("shape.config.ts only: still loads, as the typescript pack, until `config migrate` lands", async () => {
    await Bun.write(join(dir, "shape.config.ts"), "export default { beads: 'required' };\n");
    const config = await Effect.runPromise(loadConfig(dir));
    expect(config.configFile).toBe("shape.config.ts");
    expect(config.packs).toEqual(["typescript"]);
    expect(config.beads).toBe("required");
  });

  test("both: fails, naming both", async () => {
    await write('packs = ["typescript"]\n');
    await Bun.write(join(dir, "shape.config.ts"), "export default {};\n");
    const message = await fails();
    expect(message).toStartWith("shape.toml:");
    expect(message).toContain("shape.config.ts is here too, and a repo has one config");
  });

  test("neither: not found, as a missing config always was", async () => {
    expect(await fails()).toBe("shape.toml: not found; every adopting repo has one");
  });

  test("an unknown key fails, naming it: a typo or a camelCase key", async () => {
    await write('packs = ["typescript"]\npakcs = ["rust"]\n');
    const typo = await fails();
    expect(typo).toContain("Expected no excess property");
    expect(typo).toContain('["pakcs"]');
    await write('packs = ["typescript"]\n[coverage]\nexemptFiles = []\n');
    expect(await fails()).toContain('["coverage"]["exemptFiles"]');
  });

  test("packs missing: fails, listing the packs whose files the repo has", async () => {
    await write("[budgets]\nagents-lines = 120\n");
    await Bun.write(join(dir, "package.json"), "{}\n");
    await Bun.write(join(dir, "pyproject.toml"), "");
    expect(await fails()).toBe(
      'shape.toml: has no `packs`: this repo has typescript\'s files and python\'s files, so add `packs = ["typescript", "python"]` at the top, in the order their gate stages should run',
    );
  });

  test("packs missing in a repo with no pack's files: fails, naming the packs there are", async () => {
    await write("");
    expect(await fails()).toContain("(typescript, rust, python)");
  });

  test("an unknown pack fails, naming the ones there are", async () => {
    await write('packs = ["cobol"]\n');
    const message = await fails();
    expect(message).toContain('["packs"][0]');
    expect(message).toContain('"typescript"');
  });

  test("a pack listed with no file of its own: passes", async () => {
    // The directory has no TypeScript. (A shipped pack: an unshipped one fails, below.)
    await write('packs = ["typescript"]\n');
    expect((await Effect.runPromise(loadConfig(dir))).packs).toEqual(["typescript"]);
  });

  // A pack id the schema knows whose pack isn't built yet; none once every pack ships, and then
  // a config can't list one (the schema rejects an unknown id first).
  const unshipped = PACK_IDS.find((id) => PACKS[id] === undefined);
  test.skipIf(unshipped === undefined)(
    "a pack this mshape doesn't ship fails, naming it and the shipped ones",
    async () => {
      await write(`packs = ["typescript", "${unshipped}"]\n`);
      const shipped = PACK_IDS.filter((id) => PACKS[id] !== undefined).join(", ");
      expect(await fails()).toContain(
        `packs: lists \`${unshipped}\`, which this mshape doesn't ship (it ships ${shipped})`,
      );
    },
  );

  test("a module with no pack in a two-pack repo: fails, naming the module", async () => {
    await write(
      'packs = ["rust", "python"]\n[arch.modules.core]\ndescription = "x"\npack = "rust"\n[arch.modules.cli]\ndescription = "y"\n',
    );
    const message = await fails();
    expect(message).toContain("arch.modules.cli: the repo lists 2 packs (rust, python)");
    expect(message).not.toContain("arch.modules.core");
  });

  test("a module naming a pack the repo doesn't list fails, naming both", async () => {
    await write('packs = ["rust"]\n[arch.modules.core]\ndescription = "x"\npack = "python"\n');
    expect(await fails()).toContain("arch.modules.core.pack: `python` isn't in `packs` (rust)");
  });

  test("a pack listed twice fails, naming it", async () => {
    await write('packs = ["rust", "rust"]\n');
    expect(await fails()).toContain("packs: lists `rust` twice");
  });

  test("two gate stages with one name fail at load, naming it", async () => {
    await write(
      'packs = ["rust"]\n[gate]\nstages = [{ name = "lint", run = ["a"] }, { name = "lint", run = ["b"], fast = true }]\n',
    );
    expect(await fails()).toContain("gate.stages: two stages are named `lint`");
  });

  test("--config with a .toml path reads it as shape.toml", async () => {
    await Bun.write(join(dir, "trial", "try.toml"), 'packs = ["typescript"]\nbeads = "required"\n');
    const config = await Effect.runPromise(loadConfig(dir, join(dir, "trial", "try.toml")));
    expect(config.configFile).toBe("trial/try.toml");
    expect(config.beads).toBe("required");
  });
});
