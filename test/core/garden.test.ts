/** Garden over any text source: line budgets beyond TypeScript, every allowance, local rules. */
import { describe, expect, test } from "bun:test";
import { defineRule } from "../../src/api/monkeyshape.ts";
import { checkBudgets } from "../../src/core/budgets.ts";
import { garden } from "../../src/core/garden.ts";
import { formatGarden } from "../../src/core/report.ts";
import { config, repo } from "../support.ts";

const lines = (n: number): string => "x\n".repeat(n);

describe("garden and line budgets over any text source", () => {
  test("a 2000-line shell script shows in garden and fails file-lines", () => {
    const snapshot = repo({ "scripts/deploy.sh": lines(2000) });
    const report = garden(config(), snapshot, {});
    expect(report.metrics.largeFiles).toEqual([{ file: "scripts/deploy.sh", lines: 2000 }]);
    expect(formatGarden(report)).toContain("2000  scripts/deploy.sh");
    const found = checkBudgets(config(), snapshot).filter((v) => v.rule === "budgets/file-lines");
    expect(found.map((v) => `${v.rule} ${v.file}`)).toEqual([
      "budgets/file-lines scripts/deploy.sh",
    ]);
  });

  test("Python, C and an executable without an extension count; a binary, data and docs don't", () => {
    const snapshot = repo(
      {
        "tools/gen.py": lines(700),
        "native/a.c": lines(800),
        "bin/run": lines(650),
        "lib/helper.so": `\u0000${lines(900)}`,
        "data/big.json": lines(5000),
        "docs/long.md": lines(5000),
      },
      { modes: { "bin/run": "executable", "lib/helper.so": "executable" } },
    );
    expect(garden(config(), snapshot, {}).metrics.largeFiles.map((f) => f.file)).toEqual([
      "native/a.c",
      "tools/gen.py",
      "bin/run",
    ]);
  });

  test("allowances count coverage.exemptFiles and files.large too", () => {
    const shape = config({
      budgets: { largeFiles: [{ path: "a.ts", reason: "a generated table" }] },
      coverage: { exemptFiles: [{ path: "b.py", reason: "run once, by hand" }] },
      files: { large: [{ path: "c.bin", reason: "the fixture parsers read" }] },
    });
    expect(garden(shape, repo({}), {}).escapeHatches.allowances).toBe(3);
  });
});

describe("garden's local rules", () => {
  const rule = (id: string) =>
    defineRule({
      id,
      bugClass: "a class of bug",
      message: "do it the other way",
      check: () => [],
      cases: { fail: [], pass: [""] },
    });

  test("one line per local rule, under the escape hatches, only when there are any", () => {
    const shape = config({
      localRules: [rule("no-save"), rule("other")],
      rules: { "local/no-save": { allow: [{ path: "src/merge.ts", reason: "the merge itself" }] } },
    });
    const snapshot = repo({
      "src/a.ts": "// shape-ignore local/no-save: generated, reviewed\nsave(x);\n",
    });
    const text = formatGarden(garden(shape, snapshot, {}));
    expect(text).toContain(
      "  Local rules\n    rules/local/no-save       1 ignore, 1 allowance\n    rules/local/other         0 ignores, 0 allowances",
    );
    expect(text.indexOf("Local rules")).toBeGreaterThan(text.indexOf("config allowances"));
    expect(formatGarden(garden(config(), repo({}), {}))).not.toContain("Local rules");
  });
});
