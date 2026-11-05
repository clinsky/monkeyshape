/**
 * The outcome contract's case table (plan/MILESTONE.md, "Interfaces the tracks share"), one
 * test per row: what each check reports, and whether the gate is green.
 */
import { describe, expect, test } from "bun:test";
import { assess, type CheckRun } from "../../src/core/check.ts";
import type { CheckName, Outcome } from "../../src/core/model.ts";
import type { Counts } from "../../src/core/ratchet.ts";
import { formatCheck } from "../../src/core/report.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, repo } from "../support.ts";

const REASON = "scaffold data, copied by init";

/** tsc and biome both ran and saw these files. */
const tools = (...files: ReadonlyArray<string>) => ({ typechecked: files, linted: files });

const ARCH: ShapeConfig = { arch: { modules: { core: { description: "pure" } } } };

const outcomeOf = (run: CheckRun, check: CheckName): Outcome | undefined =>
  run.reports.find((report) => report.check === check)?.outcome;

const stateOf = (run: CheckRun, check: CheckName): string | undefined =>
  outcomeOf(run, check)?.state;

const rulesOf = (run: CheckRun): ReadonlyArray<string> => run.result.failing.map((v) => v.rule);

interface Row {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly config?: ShapeConfig;
  readonly options?: Parameters<typeof repo>[1];
  readonly baseline?: Counts;
  readonly only?: ReadonlyArray<CheckName>;
  /** The outcome each named check reports. */
  readonly outcomes: Partial<Record<CheckName, Outcome["state"]>>;
  readonly green: boolean;
  /** Anything else this row must show. */
  readonly also?: (run: CheckRun) => void;
}

const ROWS: ReadonlyArray<Row> = [
  {
    name: "the check ran over its files, no violations: passed, green",
    files: { "AGENTS.md": "# A\n", "src/core/a.ts": "export const a = 1;\n" },
    config: ARCH,
    options: tools("src/core/a.ts"),
    outcomes: { arch: "passed", rules: "passed", sources: "passed", coverage: "passed" },
    green: true,
    also: (run) => {
      expect(outcomeOf(run, "rules")).toMatchObject({
        examined: expect.stringContaining("1 file"),
      });
    },
  },
  {
    name: "the check ran, a violation: failed, red",
    files: { "src/core/a.ts": "throw x;\n" },
    config: ARCH,
    options: tools("src/core/a.ts"),
    outcomes: { rules: "failed", arch: "passed" },
    green: false,
  },
  {
    name: "nothing is the check's to look at, and no config asked: not-applicable, green",
    files: { "AGENTS.md": "# A\n", "README.md": "# r\n" },
    options: tools(),
    outcomes: {
      arch: "not-applicable",
      sources: "not-applicable",
      rules: "not-applicable",
      coverage: "not-applicable",
      beads: "not-applicable",
    },
    green: true,
  },
  {
    name: "TypeScript outside default sources (no src/): failed, naming the files",
    files: { "server/a.ts": "export const a = 1;\n", "lib/b.ts": "export const b = 1;\n" },
    only: ["sources", "rules"],
    // rules is never not-applicable while TypeScript exists: it says what it didn't look at.
    outcomes: { sources: "failed", rules: "passed" },
    green: false,
    also: (run) => {
      expect(outcomeOf(run, "rules")).toMatchObject({
        examined: "0 files in sources; 2 TypeScript outside it, not analyzed",
      });
      const outside = run.result.failing.filter((v) => v.rule === "sources/outside");
      expect(outside.map((v) => v.file).sort()).toEqual(["lib/b.ts", "server/a.ts"]);
      expect(outside[0]?.message).toContain("sources.include");
    },
  },
  {
    name: "TypeScript at the root and in several top-level directories, sources set: passed",
    files: {
      "index.ts": "export const i = 1;\n",
      "server/a.ts": "export const a = 1;\n",
      "lib/b.ts": "export const b = 1;\n",
    },
    config: { sources: { include: ["*.ts", "server/**/*.ts", "lib/**/*.ts"] } },
    only: ["sources", "rules"],
    outcomes: { sources: "passed", rules: "passed" },
    green: true,
    also: (run) => {
      expect(outcomeOf(run, "rules")).toMatchObject({
        examined: expect.stringContaining("3 files"),
      });
    },
  },
  {
    name: "tests, declaration files and reasoned exemptions outside sources: counted, not analyzed",
    files: {
      "src/a.ts": "export const a = 1;\n",
      "src/a.test.ts": "throw x;\n",
      "test/support.ts": "throw x;\n",
      "types/x.d.ts": "declare const x: number;\n",
      "template/t.ts": "throw x;\n",
      "shape.config.ts": "export default {};\n",
    },
    config: { sources: { exempt: [{ path: "template/**", reason: REASON }] } },
    only: ["sources", "rules"],
    outcomes: { sources: "passed", rules: "passed" },
    green: true,
    also: (run) => {
      const examined = (outcomeOf(run, "sources") as { examined: string }).examined;
      expect(examined).toContain("1 in sources");
      expect(examined).toContain("2 tests");
      expect(examined).toContain("1 declaration");
      expect(examined).toContain("2 exempt");
      expect(outcomeOf(run, "rules")).toMatchObject({
        examined: expect.stringContaining("1 file"),
      });
    },
  },
  {
    name: "a configured glob matches no file: failed, naming it",
    files: { "src/a.ts": "export const a = 1;\n" },
    config: { sources: { include: ["src/**/*.ts", "lib/**/*.ts"] } },
    only: ["sources"],
    outcomes: { sources: "failed" },
    green: false,
    also: (run) => {
      expect(run.result.failing.map((v) => v.message).join("\n")).toContain("lib/**/*.ts");
    },
  },
  {
    name: "a configured module matches no file: failed, naming it",
    files: { "src/core/a.ts": "export const a = 1;\n" },
    config: {
      arch: { modules: { core: { description: "pure" }, gone: { description: "moved" } } },
    },
    only: ["arch"],
    outcomes: { arch: "failed" },
    green: false,
    also: (run) => {
      expect(rulesOf(run)).toEqual(["arch/empty-module"]);
      expect(run.result.failing[0]?.message).toContain("'gone'");
    },
  },
  {
    name: "the same, declared optional: not-applicable, green",
    files: { "README.md": "# r\n" },
    config: {
      sources: { include: [{ path: "lib/**/*.ts", optional: true }] },
      arch: { modules: { lib: { description: "later", optional: true } } },
    },
    only: ["sources", "arch"],
    outcomes: { sources: "not-applicable", arch: "not-applicable" },
    green: true,
  },
  {
    name: "optional on a glob that does match: as if not optional",
    files: { "src/a.ts": "throw x;\n" },
    config: { sources: { include: [{ path: "src/**/*.ts", optional: true }] } },
    only: ["sources", "rules"],
    outcomes: { sources: "passed", rules: "failed" },
    green: false,
  },
  {
    name: "a required prerequisite is missing (tsc): unavailable, red",
    files: { "src/a.ts": "export const a = 1;\n", "tsconfig.json": "{}", "biome.json": "{}" },
    options: { linted: ["src/a.ts"] },
    only: ["coverage"],
    outcomes: { coverage: "unavailable" },
    green: false,
    also: (run) => {
      expect(outcomeOf(run, "coverage")).toMatchObject({ prerequisite: "tsc", required: true });
      expect(rulesOf(run)).toEqual(["prerequisites/tool-unavailable"]);
    },
  },
  {
    name: "an optional prerequisite is missing: printed as a note, green",
    files: { "src/a.ts": "export const a = 1;\n", "tsconfig.json": "{}", "biome.json": "{}" },
    config: { prerequisites: { tsc: "optional" } },
    options: { linted: ["src/a.ts"] },
    only: ["coverage"],
    outcomes: { coverage: "passed" },
    green: true,
    also: (run) => {
      expect(run.notes.join("\n")).toContain("tsc");
    },
  },
  {
    name: "a prerequisite that ran and broke: unavailable, red, even when optional",
    files: { "src/a.ts": "export const a = 1;\n" },
    config: { prerequisites: { tsc: "optional" } },
    options: { linted: ["src/a.ts"], tsc: { state: "failed", reason: "`tsc` exited 2" } },
    only: ["coverage"],
    outcomes: { coverage: "unavailable" },
    green: false,
    also: (run) => {
      expect(rulesOf(run)).toEqual(["prerequisites/tool-failed"]);
    },
  },
  {
    name: "a clone with .beads/ but no database, beads optional: unavailable note, green",
    files: { ".beads/config.yaml": "issue-prefix: x\n" },
    options: { beads: { state: "unavailable", reason: "no database" } },
    only: ["beads"],
    outcomes: { beads: "unavailable" },
    green: true,
    also: (run) => {
      expect(outcomeOf(run, "beads")).toMatchObject({ required: false });
      expect(run.notes.join("\n")).toContain("no database");
    },
  },
  {
    name: "the same, beads: required: unavailable, red",
    files: { ".beads/config.yaml": "issue-prefix: x\n" },
    config: { beads: "required" },
    options: { beads: { state: "unavailable", reason: "no database" } },
    only: ["beads"],
    outcomes: { beads: "unavailable" },
    green: false,
    also: (run) => {
      expect(outcomeOf(run, "beads")).toMatchObject({ required: true });
      expect(rulesOf(run)).toEqual(["prerequisites/beads-required"]);
    },
  },
  {
    name: "one check passed and another's tool is missing: one line each, red if required",
    files: { "src/a.ts": "export const a = 1;\n", "tsconfig.json": "{}", "biome.json": "{}" },
    options: { typechecked: ["src/a.ts"] },
    only: ["rules", "coverage"],
    outcomes: { rules: "passed", coverage: "unavailable" },
    green: false,
    also: (run) => {
      expect(outcomeOf(run, "coverage")).toMatchObject({ prerequisite: "biome" });
      const lines = formatCheck(run).split("\n");
      expect(lines.filter((line) => /^\s*rules\s+passed/.test(line))).toHaveLength(1);
      expect(lines.filter((line) => /^\s*coverage\s+unavailable/.test(line))).toHaveLength(1);
    },
  },
  {
    // 4dq: a C-only repo without node_modules reads coverage passed, its commands judged.
    name: "a repo with no TypeScript to cover needs neither tsc nor biome: its commands are judged",
    files: { "AGENTS.md": "# A\n", "native/a.c": "int main(void) { return 0; }\n" },
    config: {
      coverage: { commands: [{ files: ["native/**/*.c"], run: ["make", "-C", "native"] }] },
    },
    // Neither tool ran: no file lists, so both integrations are unavailable.
    options: { commands: [{ state: "ran", code: 0, output: "" }] },
    only: ["coverage"],
    outcomes: { coverage: "passed" },
    green: true,
    also: (run) => {
      expect(rulesOf(run).filter((rule) => rule.startsWith("prerequisites/tool-"))).toEqual([]);
      expect(outcomeOf(run, "coverage")?.state).toBe("passed");
    },
  },
  {
    name: "a prerequisite of a check --only didn't select: no effect",
    files: { "src/a.ts": "export const a = 1;\n" },
    only: ["rules"],
    outcomes: { rules: "passed" },
    green: true,
    also: (run) => {
      expect(run.reports.map((report) => report.check)).toEqual(["rules"]);
    },
  },
  {
    name: "the check is turned off with a reason: exempt, green",
    files: { "AGENTS.md": `${"line\n".repeat(400)}` },
    config: { checks: { budgets: { off: "measured elsewhere, by its own tool" } } },
    only: ["budgets"],
    outcomes: { budgets: "exempt" },
    green: true,
  },
  {
    name: "some files exempt with a reason, a violation in another: failed",
    files: { "src/a.ts": "throw x;\n", "template/t.ts": "throw y;\n" },
    config: {
      sources: {
        include: ["src/**/*.ts", "template/**/*.ts"],
        exempt: [{ path: "template/**", reason: REASON }],
      },
    },
    only: ["sources", "rules"],
    outcomes: { sources: "passed", rules: "failed" },
    green: false,
    also: (run) => {
      expect(run.result.failing.map((v) => v.file)).toEqual(["src/a.ts"]);
    },
  },
  {
    name: "every violation grandfathered by the baseline: passed, green",
    files: { "src/a.ts": "throw x;\n" },
    baseline: { "rules/no-throw": { "src/a.ts": 1 } },
    only: ["rules"],
    outcomes: { rules: "passed" },
    green: true,
  },
];

describe("the outcome contract", () => {
  for (const row of ROWS)
    test(row.name, () => {
      const run = assess(
        config(row.config ?? {}),
        repo(row.files, row.options ?? tools(...Object.keys(row.files))),
        row.baseline ?? {},
        row.only,
      );
      const states = Object.fromEntries(
        Object.keys(row.outcomes).map((check) => [check, stateOf(run, check as CheckName)]),
      );
      expect(states).toEqual(row.outcomes);
      expect({ green: run.green, failing: rulesOf(run) }).toMatchObject({ green: row.green });
      row.also?.(run);
    });

  test("the output has one line per check, with its outcome and what it examined", () => {
    const run = assess(
      config(ARCH),
      repo(
        { "AGENTS.md": "# A\n", "src/core/a.ts": "export const a = 1;\n" },
        tools("src/core/a.ts"),
      ),
    );
    const output = formatCheck(run);
    for (const report of run.reports)
      expect(output).toMatch(
        new RegExp(`^  ${report.check}\\s+${report.outcome.state}\\s+\\S`, "m"),
      );
    expect(output.split("\n").at(-1)).toBe("mshape check passed");
  });

  test("a long command's label is shortened, so it doesn't push every state across", () => {
    const run = assess(
      config(ARCH),
      repo(
        { "AGENTS.md": "# A\n", "src/core/a.ts": "export const a = 1;\n" },
        tools("src/core/a.ts"),
      ),
    );
    const long = `python3 -c import ast, sys; ${"x".repeat(80)}`;
    const reports = run.reports.map((report) =>
      report.check === "coverage"
        ? { ...report, parts: [{ label: long, outcome: report.outcome }] }
        : report,
    );
    const lines = formatCheck({ ...run, reports }).split("\n");
    const column = (line: string | undefined) => line?.search(/(passed|failed)/) ?? -1;
    const part = lines.find((line) => line.includes("python3"));
    expect(part).toContain("…");
    expect(column(part)).toBe(column(lines.find((line) => /^ {2}arch\s/.test(line))));
    expect(column(part)).toBeLessThan(45);
  });
});
