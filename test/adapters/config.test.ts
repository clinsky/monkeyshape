import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { loadConfig } from "../../src/adapters/config.ts";
import { PACKS } from "../../src/packs/index.ts";
import { DEFAULT_DOCS, PACK_IDS } from "../../src/schemas/config.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("names the file it tried: --config's path, or shape.toml", async () => {
    const given = await Effect.runPromise(Effect.flip(loadConfig(dir, join(dir, "nope.toml"))));
    expect(given.message).toBe("nope.toml: not found");
    const own = await Effect.runPromise(Effect.flip(loadConfig(dir)));
    expect(own.message).toBe("shape.toml: not found; every adopting repo has one");
    const outside = await Effect.runPromise(Effect.flip(loadConfig(dir, "/nowhere/x.toml")));
    expect(outside.message).toBe("/nowhere/x.toml: not found");
  });

  test("a TypeScript config given by --config is refused, as a repo's own one is", async () => {
    await Bun.write(join(dir, "trial", "try.config.ts"), "export default {};\n");
    const message = (
      await Effect.runPromise(Effect.flip(loadConfig(dir, join(dir, "trial", "try.config.ts"))))
    ).message;
    expect(message).toStartWith(
      "trial/try.config.ts: this mshape reads shape.toml only, not a config as code",
    );
    expect(message).toContain("mshape config migrate");
  });
});

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

  test("shape.config.ts only: fails, saying to run mshape config migrate", async () => {
    await Bun.write(join(dir, "shape.config.ts"), "export default { beads: 'required' };\n");
    const message = await fails();
    expect(message).toStartWith(
      "shape.config.ts: this mshape reads shape.toml only, not a config as code: run `mshape config migrate`",
    );
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

describe("[gate].stages names", () => {
  test("a name that isn't kebab-case fails at load, naming the key", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["typescript"]\n[[gate.stages]]\nname = "native/check"\nrun = ["make"]\n',
    );
    const message = (await Effect.runPromise(Effect.flip(loadConfig(dir)))).message;
    expect(message).toContain('["gate"]["stages"][0]["name"]');
    expect(message).toContain("lowercase words joined by hyphens");
  });

  test("mshape-check is the gate's own and can't be replaced", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["typescript"]\n[[gate.stages]]\nname = "mshape-check"\nrun = ["false"]\nfast = true\n',
    );
    expect((await Effect.runPromise(Effect.flip(loadConfig(dir)))).message).toContain(
      "`mshape-check` is the gate's own `mshape check`, which always runs and can't be replaced",
    );
  });
});

describe("a default list's { add } form", () => {
  test("is the default with the added entries after it; a whole list replaces the default", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["typescript"]\n[refs]\ndocs = { add = ["docs/guide.md", "AGENTS.md"] }\nform-only-docs = ["notes/**/*.md"]\n[coverage]\nexempt = { add = ["gen"] }\n',
    );
    const config = await Effect.runPromise(loadConfig(dir));
    expect(config.refs.docs).toEqual([...DEFAULT_DOCS, "docs/guide.md"]);
    expect(config.refs.formOnlyDocs).toEqual(["notes/**/*.md"]);
    expect(config.refs.narrativeDocs).toEqual(["README.md"]);
    expect(config.coverage.exempt.at(-1)).toBe("gen");
    expect(config.coverage.exempt).toContain("node_modules");
  });
});

describe("prerequisites", () => {
  test("take a listed pack's tool by name; one not set is as the pack declares it", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["typescript"]\n[prerequisites]\nbiome = "optional"\n',
    );
    const config = await Effect.runPromise(loadConfig(dir));
    expect(config.prerequisites).toEqual({ biome: "optional" });
  });

  test("a tool no listed pack declares fails at load, naming the ones they do", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["typescript"]\n[prerequisites]\nrustc = "optional"\n',
    );
    expect((await Effect.runPromise(Effect.flip(loadConfig(dir)))).message).toContain(
      "prerequisites.rustc: no listed pack (typescript) has a tool `rustc`; the ones that can be set are tsc, biome",
    );
  });
});

describe("prerequisites nothing reads", () => {
  test("a tool its pack checks only for itself is refused, saying which can be set (#110's review)", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["rust"]\n[prerequisites]\nrustfmt = "optional"\n',
    );
    const message = (await Effect.runPromise(Effect.flip(loadConfig(dir)))).message;
    expect(message).toContain(
      "prerequisites.rustfmt: `rustfmt` is a tool its pack checks for itself, and no check or gate stage reads a setting for it",
    );
    expect(message).toContain("the ones that can are rustc, clippy");
  });

  test("a tool a gate stage stands for loads", async () => {
    await Bun.write(
      join(dir, "shape.toml"),
      'packs = ["rust"]\n[prerequisites]\nclippy = "optional"\n',
    );
    expect((await Effect.runPromise(loadConfig(dir))).prerequisites).toEqual({
      clippy: "optional",
    });
  });
});
