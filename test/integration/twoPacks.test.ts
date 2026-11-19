/**
 * Two packs in one repo, composed by `mshape check` (goal 4: designed for, not built for; no
 * init for several packs). TypeScript under `src/`, a uv project under `py/`: each file has
 * one pack, each module belongs to one, and the findings of both languages merge in one
 * report. Only checks that need no tool run, so it runs wherever the gate does.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, run } from "./harness.ts";

const CLI = join(ROOT, "src", "cli", "main.ts");

const FILES: Readonly<Record<string, string>> = {
  "shape.toml": `packs = ["typescript", "python"]

# The Python project is under py/, not the root: its sources are named here.
[sources]
include = ["src/**/*.ts", "py/src/**/*.py"]

[arch.modules.core]
description = "TypeScript logic."
pack = "typescript"

[arch.modules.cli]
description = "TypeScript entry point."
pack = "typescript"
may-import = ["core"]
host-access = true

[arch.modules.model]
description = "Python logic."
pack = "python"
paths = ["py/src/svc/core"]

[arch.modules.io]
description = "Python host access."
pack = "python"
paths = ["py/src/svc/io", "py/src/svc/__init__.py"]
may-import = ["model"]
host-access = true
`,
  "py/pyproject.toml": '[project]\nname = "svc"\nversion = "0.1.0"\n',
  // Each language: a forbidden import upward, closing a cycle, and one rule's finding.
  "src/core/a.ts":
    'import { main } from "../cli/main.ts";\n\nexport const a = () => main;\nexport const b = () => {\n  throw new Error("no");\n};\n',
  "src/cli/main.ts": 'import { a } from "../core/a.ts";\n\nexport const main = () => a;\n',
  "py/src/svc/__init__.py": "",
  "py/src/svc/core/__init__.py": "",
  "py/src/svc/io/__init__.py": "",
  "py/src/svc/core/model.py":
    "from svc.io import disk\n\n\ndef total(xs):\n    print(xs)\n    # shape-ignore local/no-print: the one debug line this fixture keeps\n    print(len(xs))\n    return disk.read()\n",
  "py/src/svc/io/disk.py": "from svc.core import model\n\n\ndef read():\n    return model\n",
  // The repo's own rule, in the second pack's language.
  "shape-rules/no-print.yml":
    "id: no-print\nlanguage: python\nrule:\n  pattern: print($$$A)\nmessage: print writes to stdout from library code; log through the logger instead\nmetadata:\n  bugClass: Library code writing to stdout, which every caller inherits\n",
  "shape-rules/no-print.test.yml": 'invalid: ["print(1)"]\nvalid: ["log.info(1)"]\n',
};

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-two-packs-"));
  for (const [path, text] of Object.entries(FILES)) await Bun.write(join(dir, path), text);
  await run(dir, ["git", "init", "-q"]);
  await run(dir, ["git", "add", "--all"]);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("two packs in one repo", () => {
  test("claims are disjoint, modules keep to their pack, and both languages' findings merge", async () => {
    const checked = await run(dir, [
      process.execPath,
      CLI,
      "check",
      "--only",
      "sources,arch,rules",
    ]);
    const found = checked.output
      .split("\n")
      .filter((line) => /^\S+ +\S+\/\S+$/u.test(line.trim()) && !line.startsWith(" "))
      .map((line) => line.replace(/ {2,}/gu, " "));
    expect(found).toEqual([
      "py/src/svc/core/model.py arch/cycle",
      "py/src/svc/core/model.py:1 arch/forbidden-import",
      // Line 7's print is under a shape-ignore, in Python's comment syntax.
      "py/src/svc/core/model.py:5 rules/local/no-print",
      "src/cli/main.ts arch/cycle",
      "src/core/a.ts arch/forbidden-import",
      "src/core/a.ts:5 rules/no-throw",
    ]);
    expect(checked.output).toContain(
      "module 'model' may not import module 'io' ('from svc.io import disk')",
    );
    expect(checked.output).toContain(
      "module 'core' may not import module 'cli' ('../cli/main.ts')",
    );
    // Every file has exactly one pack: none claimed twice, none unclaimed.
    expect(checked.output).toMatch(/sources +passed +7 TypeScript or Python files: 7 in sources/u);
    expect(checked.output).toMatch(/arch +failed +7 files in 4 modules/u);
    expect(checked.code).toBe(1);
  }, 120_000);
});
