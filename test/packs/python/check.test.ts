import { describe, expect, test } from "bun:test";
import { runChecks } from "../../../src/core/check.ts";
import type { ToolRun } from "../../../src/packs/pack.ts";
import { python, RUFF, TY } from "../../../src/packs/python/index.ts";
import {
  type ResolvedConfig,
  resolveConfig,
  type ShapeConfig,
} from "../../../src/schemas/config.ts";
import { repo } from "../../support.ts";

/** Resolved as the CLI resolves it: `sources` defaults from the listed pack. */
const config = (input: ShapeConfig): ResolvedConfig =>
  resolveConfig(input, "shape.toml", [], { python: python.defaultSources.include });

const PYPROJECT = [
  "[project]",
  'name = "app"',
  'version = "0.1.0"',
  "",
  "[tool.ruff]",
  'extend = ".mshape/ruff.toml"',
  "",
].join("\n");

// A uv project in the src layout: app.core is pure, app.io touches the host, app.cli wires.
const FILES: Readonly<Record<string, string>> = {
  "pyproject.toml": PYPROJECT,
  "src/app/__init__.py": "",
  "src/app/core/__init__.py": "",
  "src/app/core/model.py": "from dataclasses import dataclass\nimport yaml\n",
  "src/app/core/rules.py": "from . import model\nfrom app.io import disk\n",
  "src/app/io/__init__.py": "",
  "src/app/io/disk.py": "import os\nfrom ..core.model import Thing\n",
  "src/app/cli.py": "from app.core import model, rules\nfrom app.io.disk import read\n",
  "tests/test_cli.py": "import pytest\nfrom app import cli\n",
};

const ran = (tool: string, files: ReadonlyArray<string>): ToolRun => ({
  tool,
  integration: { state: "ok" },
  files: new Set(files),
});

const SOURCES = Object.keys(FILES).filter((file) => file.endsWith(".py"));

const snapshot = (
  files: Readonly<Record<string, string>> = FILES,
  tools: ReadonlyArray<ToolRun> = [ran(RUFF, SOURCES), ran(TY, SOURCES)],
) => repo(files, { packs: [{ pack: python, load: { tools, outputs: new Map() } }] });

const MODULES = {
  core: {
    description: "the domain",
    paths: ["src/app/core"],
    packages: ["yaml"],
  },
  io: {
    description: "the host",
    paths: ["src/app/io"],
    mayImport: ["core"],
    hostAccess: true,
  },
  cli: {
    description: "the entry",
    paths: ["src/app/cli.py", "src/app/__init__.py"],
    mayImport: ["core", "io"],
  },
};

const shape = config({ packs: ["python"], arch: { modules: MODULES } });

const archOf = (input: ResolvedConfig, files?: Readonly<Record<string, string>>) =>
  runChecks(input, snapshot(files), ["arch"]).map((v) => [v.rule, v.file, v.line]);

describe("the Python pack through mshape's checks", () => {
  test("arch reports the forbidden import, at its line, and no other", () => {
    expect(archOf(shape)).toEqual([["arch/forbidden-import", "src/app/core/rules.py", 2]]);
  });

  test("the same graph with the import allowed: a relative, a src-layout and a test edge pass", () => {
    const allowed = config({
      packs: ["python"],
      arch: { modules: { ...MODULES, core: { ...MODULES.core, mayImport: ["io"] } } },
    });
    // Modules core and io now depend on each other, but no file does on itself through them:
    // rules.py -> disk.py -> model.py. arch's cycles are between files.
    expect(archOf(allowed)).toEqual([]);
  });

  test("a third-party import is a package edge on its import name; the stdlib is none", () => {
    const strict = config({
      packs: ["python"],
      arch: { modules: { ...MODULES, core: { ...MODULES.core, packages: [] } } },
    });
    const found = runChecks(strict, snapshot(), ["arch"]).filter(
      (v) => v.rule === "arch/forbidden-package",
    );
    expect(found.map((v) => [v.file, v.line])).toEqual([["src/app/core/model.py", 2]]);
    expect(found[0]?.message).toContain("yaml");
  });

  test("`from __future__ import annotations` is the language's own, no edge (review of #108)", () => {
    const files = {
      ...FILES,
      "src/app/core/model.py": "from __future__ import annotations\n",
    };
    const strict = config({
      packs: ["python"],
      arch: { modules: { ...MODULES, core: { ...MODULES.core, packages: [] } } },
    });
    expect(runChecks(strict, snapshot(files), ["arch"]).map((v) => v.rule)).toEqual([
      "arch/forbidden-import",
    ]);
  });

  test("a host module outside a hostAccess module is host access", () => {
    const files = { ...FILES, "src/app/core/model.py": "import subprocess\n" };
    const found = runChecks(shape, snapshot(files), ["arch"]).filter(
      (v) => v.rule === "arch/host-access",
    );
    expect(found.map((v) => [v.file, v.line])).toEqual([["src/app/core/model.py", 1]]);
    expect(found[0]?.message).toContain("imports 'subprocess'");
  });

  test("a host submodule named in a from-import, and the builtin open(), are host access", () => {
    const files = {
      ...FILES,
      "src/app/core/model.py":
        "from urllib import parse, request\nfrom urllib.parse import quote\n\n\ndef load(p: str) -> str:\n    with open(p) as f:\n        return f.read()\n",
    };
    const found = runChecks(shape, snapshot(files), ["arch"])
      .filter((v) => v.rule === "arch/host-access")
      .map((v) => v.line);
    expect(found).toEqual([6, 1]);
  });

  test("open() as a method, or rebound by the file, is not the builtin", () => {
    const files = {
      ...FILES,
      "src/app/core/model.py": "def f(p: object) -> object:\n    return p.open()\n",
      "src/app/core/rules.py": "from .model import open\n\nopen(1)\n",
    };
    const found = runChecks(shape, snapshot(files), ["arch"]).filter(
      (v) => v.rule === "arch/host-access",
    );
    expect(found).toEqual([]);
  });

  test("open bound in a class, a function or a call's keywords is still the builtin at the top (review of #108)", () => {
    const files = {
      ...FILES,
      "src/app/core/model.py": [
        "class Store:",
        "    open: bool = False",
        "",
        "    def open(self) -> None: ...",
        "",
        "",
        "def make() -> dict[str, int]:",
        "    return dict(",
        "        open=1,",
        "    )",
        "",
        "",
        'data = open("x").read()',
        "",
      ].join("\n"),
    };
    const found = runChecks(shape, snapshot(files), ["arch"])
      .filter((v) => v.rule === "arch/host-access")
      .map((v) => v.line);
    expect(found).toEqual([13]);
  });

  test("a first-party import of a module that doesn't exist is unresolved", () => {
    const files = { ...FILES, "src/app/cli.py": "from app.core import missing\nimport app.nope\n" };
    const found = runChecks(shape, snapshot(files), ["arch"])
      .filter((v) => v.rule === "arch/unresolved-import")
      .map((v) => [v.file, v.line]);
    expect(found).toEqual([["src/app/cli.py", 2]]);
  });

  test("a relative import that names no module is unresolved", () => {
    const files = { ...FILES, "src/app/io/disk.py": "from ..core.gone import Thing\n" };
    const found = runChecks(shape, snapshot(files), ["arch"])
      .filter((v) => v.rule === "arch/unresolved-import")
      .map((v) => [v.file, v.line]);
    expect(found).toEqual([["src/app/io/disk.py", 1]]);
  });

  test("coverage reports a source ty doesn't check, naming ty's config", () => {
    const missed = SOURCES.filter((file) => file !== "src/app/io/disk.py");
    const found = runChecks(shape, snapshot(FILES, [ran(RUFF, SOURCES), ran(TY, missed)]), [
      "coverage",
    ]);
    expect(found.map((v) => [v.rule, v.file])).toEqual([
      ["coverage/typecheck", "src/app/io/disk.py"],
    ]);
    expect(found[0]?.message).toContain("[tool.ty.src]");
  });

  test("every .py file is in sources by the pack's default, and no rule misreads Python", () => {
    expect(runChecks(shape, snapshot(), ["sources", "rules"])).toEqual([]);
  });

  test("a shape-ignore in a # comment is read: an unused one is reported", () => {
    const files = {
      ...FILES,
      "src/app/cli.py": `${FILES["src/app/cli.py"]}# shape-ignore no-throw: kept for the test\n`,
    };
    const found = runChecks(shape, snapshot(files), ["rules"]).map((v) => [v.rule, v.line]);
    expect(found).toEqual([["rules/unused-ignore", 3]]);
  });
});

describe("the Python pack's own findings", () => {
  const findings = (files: Readonly<Record<string, string>>) =>
    runChecks(shape, snapshot(files), ["packs"]).map((v) => [v.rule, v.file, v.line, v.message]);

  test("a pyproject with no [tool.ruff]: add extend, and where", () => {
    const [found] = findings({ ...FILES, "pyproject.toml": '[project]\nname = "app"\n' });
    expect(found?.slice(0, 3)).toEqual(["packs/python/ruff-extend", "pyproject.toml", undefined]);
    expect(found?.[3]).toContain('add `extend = ".mshape/ruff.toml"` under `[tool.ruff]`');
  });

  test("[tool.ruff] extending another file: named at its line", () => {
    const text =
      '[project]\nname = "app"\n\n[tool.ruff]\nline-length = 100\nextend = "base.toml"\n';
    const [found] = findings({ ...FILES, "pyproject.toml": text });
    expect(found?.slice(0, 3)).toEqual(["packs/python/ruff-extend", "pyproject.toml", 6]);
    expect(found?.[3]).toContain("extends base.toml, not the curated rules");
  });

  test("a ruff.toml wins over pyproject, as ruff reads them, and `./` is the same path", () => {
    expect(findings({ ...FILES, "ruff.toml": 'extend = "./.mshape/ruff.toml"\n' })).toEqual([]);
    const [found] = findings({ ...FILES, "ruff.toml": "line-length = 100\n" });
    expect(found?.slice(0, 2)).toEqual(["packs/python/ruff-extend", "ruff.toml"]);
    expect(found?.[3]).toContain("at the top of ruff.toml");
  });

  test("a ruff lint.exclude or format.exclude, which ruff's file list doesn't show (review of #108)", () => {
    const lint = `${PYPROJECT}\n[tool.ruff.lint]\nexclude = ["scripts/*"]\n`;
    const [found] = findings({ ...FILES, "pyproject.toml": lint });
    expect(found?.slice(0, 3)).toEqual(["packs/python/ruff-exclude", "pyproject.toml", 9]);
    expect(found?.[3]).toContain("`[tool.ruff.lint]` `exclude`");
    expect(found?.[3]).toContain("coverage.exempt");
    const format = { ...FILES, "tools/ruff.toml": '[format]\nexclude = ["gen.py"]\n' };
    expect(findings(format).map((row) => [row[0], row[1], row[2]])).toEqual([
      ["packs/python/ruff-exclude", "tools/ruff.toml", 2],
    ]);
    // The dotted form under [tool.ruff] is the same key, at its own line.
    const dotted = PYPROJECT.replace("[tool.ruff]\n", '[tool.ruff]\nlint.exclude = ["x"]\n');
    expect(findings({ ...FILES, "pyproject.toml": dotted }).map((row) => row[2])).toEqual([6]);
    // per-file-ignores with ALL silences a file the same way; with codes, it doesn't.
    const all = `${PYPROJECT}\n[tool.ruff.lint.per-file-ignores]\n"scripts/*.py" = ["ALL"]\n"tests/*" = ["S101"]\n`;
    const ignored = findings({ ...FILES, "pyproject.toml": all });
    expect(ignored.map((row) => [row[0], row[2]])).toEqual([["packs/python/ruff-exclude", 9]]);
    expect(ignored[0]?.[3]).toContain(
      "`per-file-ignores` turns off every ruff rule for `scripts/*.py`",
    );
    // The deprecated top-level form, which ruff 0.17.5 still reads (re-review of #108).
    const legacy = `${PYPROJECT}\n[tool.ruff.per-file-ignores]\n"scripts/*.py" = ["ALL"]\n`;
    const old = findings({ ...FILES, "pyproject.toml": legacy });
    expect(old.map((row) => [row[0], row[2]])).toEqual([["packs/python/ruff-exclude", 9]]);
    expect(old[0]?.[3]).toContain("`per-file-ignores` turns off every ruff rule");
    // ruff's top-level exclude is in its file list, so coverage holds it: no finding.
    const top = `${PYPROJECT.replace("[tool.ruff]\n", '[tool.ruff]\nexclude = ["gen"]\n')}`;
    expect(findings({ ...FILES, "pyproject.toml": top })).toEqual([]);
  });

  test("a root ty.toml: ty would ignore the synced rules", () => {
    const found = findings({ ...FILES, "ty.toml": "[rules]\n" }).map((row) => row[0]);
    expect(found).toEqual(["packs/python/ty-config"]);
  });
});
