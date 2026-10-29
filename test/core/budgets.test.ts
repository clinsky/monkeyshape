import { describe, expect, test } from "bun:test";
import { checkBudgets } from "../../src/core/budgets.ts";
import { config, repo } from "../support.ts";

const lines = (n: number) => `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;

const entry = (slug: string, overrides: Record<string, string> = {}) => {
  const fields: Record<string, string> = {
    Decision: "Do the thing.",
    "Tempting wrong fix": "The other thing.",
    Evidence: "measured: it broke twice",
    "Enforced by": "test/a.test.ts",
    "Revisit when": "it stops being true",
    ...overrides,
  };
  return `## ${slug}: Title\n${Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n`;
};

const base = { "AGENTS.md": "# Agents\n", "test/a.test.ts": "" };
const rules = (
  files: Record<string, string>,
  input = config(),
  memories?: Record<string, string>,
) =>
  checkBudgets(input, repo({ ...base, ...files }, memories === undefined ? {} : { memories })).map(
    (v) => v.rule,
  );

describe("budgets", () => {
  test("a repo within budget passes", () => {
    expect(rules({ "DECISIONS.md": `# Decisions\n\n${entry("D-one")}` })).toEqual([]);
  });

  test("AGENTS.md is required and capped", () => {
    expect(checkBudgets(config(), repo({})).map((v) => v.rule)).toEqual(["budgets/agents-missing"]);
    expect(rules({ "AGENTS.md": lines(151) })).toEqual(["budgets/agents-lines"]);
  });

  test("CLAUDE.md only points at AGENTS.md", () => {
    expect(rules({ "CLAUDE.md": "@AGENTS.md\n" })).toEqual([]);
    expect(rules({ "CLAUDE.md": "@AGENTS.md\n\n## Beads\nuse bd\n" })).toEqual([
      "budgets/claude-md",
    ]);
  });

  test("decisions need every field and a real enforcement path unless they are policy", () => {
    expect(rules({ "DECISIONS.md": entry("D-one", { "Revisit when": "" }) })).toEqual([
      "budgets/decision-field",
    ]);
    expect(
      rules({ "DECISIONS.md": entry("D-one", { "Enforced by": "test/gone.test.ts" }) }),
    ).toEqual(["budgets/decision-unenforced"]);
    expect(
      rules({ "DECISIONS.md": entry("D-one", { "Enforced by": "none", Evidence: "policy" }) }),
    ).toEqual([]);
    expect(rules({ "DECISIONS.md": entry("D-one", { Evidence: "vibes" }) })).toEqual([
      "budgets/decision-evidence",
    ]);
  });

  test("decisions are capped in number and length, and slugs are unique", () => {
    const many = Array.from({ length: 16 }, (_, i) => entry(`D-n${i}`)).join("\n");
    expect(rules({ "DECISIONS.md": many })).toEqual(["budgets/decisions-count"]);
    expect(rules({ "DECISIONS.md": entry("D-one", { Decision: "word ".repeat(150) }) })).toEqual([
      "budgets/decision-words",
    ]);
    expect(rules({ "DECISIONS.md": entry("D-one") + entry("D-one") })).toEqual([
      "budgets/decision-duplicate",
    ]);
  });

  test("memories are capped when beads answered", () => {
    const memories = Object.fromEntries(
      Array.from({ length: 13 }, (_, i) => [`m${i}`, "a principle"]),
    );
    expect(rules({}, config(), memories)).toEqual(["budgets/memories-count"]);
    expect(rules({}, config(), { big: "x".repeat(7000) })).toEqual(["budgets/memories-bytes"]);
  });

  test("oversized files fail unless allowed with a reason; stale allowances fail too", () => {
    expect(rules({ "src/big.ts": lines(1201) })).toEqual(["budgets/file-lines"]);
    const allowed = config({
      budgets: { largeFiles: [{ path: "src/big.ts", reason: "generated parser table" }] },
    });
    expect(rules({ "src/big.ts": lines(1201) }, allowed)).toEqual([]);
    expect(rules({ "src/big.ts": lines(10) }, allowed)).toEqual(["budgets/unused-allowance"]);
  });
});
