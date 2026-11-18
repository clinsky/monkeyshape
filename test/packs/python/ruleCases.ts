/** The Python pack's finding kinds, each with its must-fail and must-pass case. */

import { python } from "../../../src/packs/python/index.ts";
import type { ShapeConfig } from "../../../src/schemas/config.ts";
import type { Cases } from "../../core/ruleCase.ts";
import { listed } from "../../support.ts";

/** The Python pack, listed alone, its sources in `app/`. */
const PYTHON: ShapeConfig = { packs: ["python"], sources: { include: ["app/**/*.py"] } };

/** A pyproject whose ruff config extends the curated copy. */
const PYPROJECT = '[project]\nname = "x"\n\n[tool.ruff]\nextend = ".mshape/ruff.toml"\n';

export const pythonCases: Record<string, Cases> = {
  "packs/python/ruff-extend": {
    fail: {
      config: PYTHON,
      files: { "pyproject.toml": '[project]\nname = "x"\n', "app/a.py": "" },
      options: { packs: [listed(python)] },
    },
    pass: {
      config: PYTHON,
      files: {
        "pyproject.toml": '[project]\nname = "x"\n\n[tool.ruff]\nextend = ".mshape/ruff.toml"\n',
        "app/a.py": "",
      },
      options: { packs: [listed(python)] },
    },
  },
  "packs/python/ruff-exclude": {
    fail: {
      config: PYTHON,
      files: { "pyproject.toml": `${PYPROJECT}\n[tool.ruff.lint]\nexclude = ["app/b.py"]\n` },
      options: { packs: [listed(python)] },
    },
    // A top-level exclude: ruff's file list leaves the file out, so coverage reports it.
    pass: {
      config: PYTHON,
      files: {
        "pyproject.toml": PYPROJECT.replace(
          "[tool.ruff]\n",
          '[tool.ruff]\nexclude = ["app/b.py"]\n',
        ),
      },
      options: { packs: [listed(python)] },
    },
  },
  "packs/python/ty-config": {
    fail: {
      config: PYTHON,
      files: { "pyproject.toml": PYPROJECT, "ty.toml": "[rules]\n", "app/a.py": "" },
      options: { packs: [listed(python)] },
    },
    pass: {
      config: PYTHON,
      files: { "pyproject.toml": `${PYPROJECT}\n[tool.ty.rules]\n`, "app/a.py": "" },
      options: { packs: [listed(python)] },
    },
  },
};
