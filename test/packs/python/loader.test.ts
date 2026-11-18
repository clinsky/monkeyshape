import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { loadPython } from "../../../src/adapters/packs/python.ts";
import { python, RUFF, TY } from "../../../src/packs/python/index.ts";
import { effectiveTyRules, renderTyRules } from "../../../src/packs/python/tyRules.ts";
import { resolveConfig } from "../../../src/schemas/config.ts";

const SHAPE = resolveConfig({ packs: ["python"] }, "shape.toml", [], {
  python: python.defaultSources.include,
});

/** The versions the pack is built against; the template pins the same. ty, pinned: D-ty. */
const VERSIONS = { ruff: "0.17.5", ty: "0.0.106", pytest: "9.2.0" };

const PYPROJECT = [
  "[project]",
  'name = "app"',
  'version = "0.1.0"',
  'requires-python = ">=3.10"',
  "dependencies = []",
  "",
  "[build-system]",
  'requires = ["uv_build>=0.8.22,<0.9.0"]',
  'build-backend = "uv_build"',
  "",
  "[dependency-groups]",
  `dev = ["pytest==${VERSIONS.pytest}", "ruff==${VERSIONS.ruff}", "ty==${VERSIONS.ty}"]`,
  "",
  "[tool.ruff]",
  'extend = ".mshape/ruff.toml"',
  'extend-exclude = ["src/app/generated.py"]',
  "",
  renderTyRules(effectiveTyRules(undefined)),
  "[tool.ty.src]",
  'exclude = ["src/app/untyped.py"]',
  "",
].join("\n");

const FILES: Readonly<Record<string, string>> = {
  "pyproject.toml": PYPROJECT,
  "src/app/__init__.py": "",
  "src/app/core.py": "def double(x: int) -> int:\n    return x * 2\n",
  "src/app/generated.py": "",
  "src/app/untyped.py": "",
  "tests/test_core.py":
    "from app.core import double\n\n\ndef test_double():\n    assert double(2) == 4\n",
};

const scratch = (name: string) => mkdtemp(join(tmpdir(), `python-${name}-`));

const write = async (root: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
};

const load = (root: string, files: Readonly<Record<string, string>>, checks = ["coverage"]) =>
  Effect.runPromise(
    loadPython({
      root,
      config: SHAPE,
      repo: { files: Object.keys(files), texts: new Map(Object.entries(files)) },
      checks: checks as never,
    }),
  );

const run = (root: string, argv: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([...argv], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: ran.exitCode, out: `${ran.stdout.toString()}${ran.stderr.toString()}` };
};

describe("loadPython without uv's help", () => {
  test("coverage not selected: neither tool runs", async () => {
    const loaded = await load("/nonexistent", { "src/a.py": "" }, ["arch"]);
    expect(loaded.tools.map((tool) => tool.integration.state)).toEqual([
      "unavailable",
      "unavailable",
    ]);
  });

  test("no pyproject.toml and no Python: absent", async () => {
    const loaded = await load("/nonexistent", { "README.md": "" });
    expect(loaded.tools.map((tool) => tool.integration)).toEqual([
      { state: "absent" },
      { state: "absent" },
    ]);
  });

  test("Python sources but no pyproject.toml: failed, saying how to make one", async () => {
    const loaded = await load("/nonexistent", { "src/a.py": "" });
    const integration = loaded.tools[0]?.integration;
    expect(integration?.state === "failed" && integration.reason).toContain("`uv init --bare`");
  });
});

describe.skipIf(Bun.which("uv") === null)("loadPython and the gate's stages, with uv", () => {
  let project = "";

  beforeAll(async () => {
    project = await scratch("project");
    await write(project, FILES);
    await cp(
      join(import.meta.dir, "..", "..", "..", "config", "python", "ruff.toml"),
      join(project, ".mshape", "ruff.toml"),
    );
    const locked = run(project, ["uv", "sync", "--quiet"]);
    if (locked.code !== 0) throw new Error(`uv sync failed: ${locked.out}`);
  }, 120_000);

  afterAll(async () => {
    await rm(project, { recursive: true, force: true });
  });

  test("ruff's and ty's own file lists, each without the file its config excludes", async () => {
    const loaded = await load(project, FILES);
    const files = (tool: string) => {
      const found = loaded.tools.find((run) => run.tool === tool);
      expect(found?.integration).toEqual({ state: "ok" });
      return [...(found?.files ?? [])].filter((file) => file.endsWith(".py")).sort();
    };
    expect(files(RUFF)).toEqual([
      "src/app/__init__.py",
      "src/app/core.py",
      "src/app/untyped.py",
      "tests/test_core.py",
    ]);
    expect(files(TY)).toEqual([
      "src/app/__init__.py",
      "src/app/core.py",
      "src/app/generated.py",
      "tests/test_core.py",
    ]);
  });

  test("every stage passes on the clean project, pytest included", () => {
    for (const stage of python.stages) {
      const ran = run(project, stage.run);
      expect({ stage: stage.name, ok: (stage.okExit ?? [0]).includes(ran.code) }).toEqual({
        stage: stage.name,
        ok: true,
      });
    }
  });

  test("a type error fails ty's stage, and a curated ruff rule fails ruff's", async () => {
    const root = await scratch("broken");
    try {
      await cp(project, root, { recursive: true });
      await Bun.write(
        join(root, "src/app/core.py"),
        'def double(x: int) -> int:\n    return "x"\n',
      );
      await Bun.write(join(root, "src/app/talk.py"), 'def hi() -> None:\n    print("hi")\n');
      const stage = (name: string) => {
        const found = python.stages.find((candidate) => candidate.name === name);
        return run(root, found?.run ?? []);
      };
      const ty = stage("ty");
      expect(ty.code).toBe(1);
      expect(ty.out).toContain("invalid-explicit-return");
      const ruff = stage("ruff");
      expect(ruff.code).toBe(1);
      expect(ruff.out).toContain("T201");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a curated ty rule is an error: a possibly-unbound name fails ty's stage", async () => {
    const root = await scratch("unbound");
    try {
      await cp(project, root, { recursive: true });
      await Bun.write(
        join(root, "src/app/core.py"),
        "def pick(flag: bool) -> int:\n    if flag:\n        value = 1\n    return value\n",
      );
      const ran = run(root, ["uv", "run", "--frozen", "ty", "check"]);
      expect(ran.code).toBe(1);
      expect(ran.out).toContain("possibly-unresolved-reference");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`ty ${VERSIONS.ty} has no extends, which is why its rules are a table sync owns`, async () => {
    const root = await scratch("extends");
    try {
      await cp(project, root, { recursive: true });
      await Bun.write(join(root, "ty.toml"), 'extends = ".mshape/ty.toml"\n');
      const ran = run(root, ["uv", "run", "--frozen", "ty", "check"]);
      // When a ty gains `extends`, this fails: deliver its rules by copy, as ruff's are.
      expect(ran.code).toBe(2);
      expect(ran.out).toContain("unknown field `extends`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a project with no uv.lock: failed, saying to lock", async () => {
    const root = await scratch("unlocked");
    try {
      await write(root, FILES);
      const loaded = await load(root, FILES);
      const integration = loaded.tools[0]?.integration;
      expect(integration?.state === "failed" && integration.reason).toContain("run `uv lock`");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ty not a dev dependency: unavailable, which its prerequisite says how to fix", async () => {
    const root = await scratch("no-ty");
    try {
      const files = {
        ...FILES,
        "pyproject.toml": PYPROJECT.replace(`, "ty==${VERSIONS.ty}"`, ""),
      };
      await write(root, files);
      expect(run(root, ["uv", "lock", "--quiet"]).code).toBe(0);
      const loaded = await load(root, files);
      expect(loaded.tools.find((tool) => tool.tool === TY)?.integration).toEqual({
        state: "unavailable",
        reason: "ty isn't installed in the project's environment",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
