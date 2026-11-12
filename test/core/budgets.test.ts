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

/** The enforcing file cites every slug the cases use, as the back-link asks. */
const base = {
  "AGENTS.md": "# Agents\n",
  "test/a.test.ts": `// D-one ${Array.from({ length: 16 }, (_, i) => `D-n${i}`).join(" ")}\n`,
};
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

describe("the decision back-link: each file a decision names cites its slug", () => {
  const found = (enforcedBy: string, files: Record<string, string>, evidence = "measured: x") =>
    checkBudgets(
      config(),
      repo({
        "AGENTS.md": "# Agents\n",
        "DECISIONS.md": `# Decisions\n\n${entry("D-one", { "Enforced by": enforcedBy, Evidence: evidence })}`,
        ...files,
      }),
    )
      .filter((v) => v.rule.startsWith("budgets/decision-"))
      .map((v) => `${v.rule} ${v.file}`);

  test("a file that cites the slug passes", () => {
    expect(found("src/a.ts", { "src/a.ts": "// Held here: D-one.\n" })).toEqual([]);
  });

  test("a file that doesn't fails, naming the decision and the file", () => {
    const [v] = checkBudgets(
      config(),
      repo({
        "AGENTS.md": "# Agents\n",
        "DECISIONS.md": `# Decisions\n\n${entry("D-one", { "Enforced by": "src/a.ts" })}`,
        "src/a.ts": "// D-one-more is another decision\n",
      }),
    ).filter((x) => x.rule === "budgets/decision-unlinked");
    expect([v?.file, v?.message]).toEqual([
      "src/a.ts",
      "enforces D-one (\"Title\", DECISIONS.md) but doesn't name it, so whoever edits this file isn't told why it must stay. Add a comment citing D-one where the decision is held.",
    ]);
  });

  test("a directory passes when any file under it cites the slug", () => {
    expect(
      found("test/core/", { "test/core/a.test.ts": "", "test/core/b.test.ts": "// D-one" }),
    ).toEqual([]);
    expect(
      found("test/core/", { "test/core/a.test.ts": "", "test/coreish.ts": "// D-one" }),
    ).toEqual(["budgets/decision-unlinked test/core"]);
  });

  test("a path followed by a parenthetical note: the note is ignored, the path checked", () => {
    expect(found("`src/a.ts` (its second case)", { "src/a.ts": "// D-one" })).toEqual([]);
    expect(found("`src/a.ts` (D-one is cited here)", { "src/a.ts": "" })).toEqual([
      "budgets/decision-unlinked src/a.ts",
    ]);
  });

  test("policy with no enforcement: nothing to link; a policy that names a file links it", () => {
    expect(found("none", {}, "policy")).toEqual([]);
    expect(found("src/a.ts", { "src/a.ts": "" }, "policy")).toEqual([
      "budgets/decision-unlinked src/a.ts",
    ]);
  });

  test("a named path that doesn't exist fails as a missing path, not as unlinked", () => {
    expect(found("src/gone.ts", {})).toEqual(["budgets/decision-unenforced DECISIONS.md"]);
  });

  test("one file enforcing two decisions must cite both", () => {
    const two = (text: string) =>
      checkBudgets(
        config(),
        repo({
          "AGENTS.md": "# Agents\n",
          "DECISIONS.md": `# Decisions\n\n${entry("D-one", { "Enforced by": "src/a.ts" })}\n${entry("D-two", { "Enforced by": "src/a.ts" })}`,
          "src/a.ts": text,
        }),
      )
        .filter((v) => v.rule === "budgets/decision-unlinked")
        .map((v) => v.message.split(" ")[1]);
    expect(two("// D-one\n")).toEqual(["D-two"]);
    expect(two("// D-one and D-two\n")).toEqual([]);
  });
});
