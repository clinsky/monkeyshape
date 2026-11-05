/**
 * Caps on everything loaded automatically, and the shape of DECISIONS.md. Prose costs
 * every session, so these fail the gate rather than warn.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { PRIME_FILE, PRIME_LINES } from "./conventions.ts";
import { EVIDENCE_KINDS, FIELDS, parseDecisions, SLUG } from "./decisions.ts";
import { matchesAny } from "./glob.ts";
import { lineCount, lineSources, pathIndex, type Snapshot, type Violation } from "./model.ts";

/** Every rule this check reports, as `budgets/<kind>`; test/core/ruleCases.test.ts covers each. */
export const BUDGETS_RULES = [
  "agents-missing",
  "agents-lines",
  "claude-md",
  "readme-lines",
  "decisions-count",
  "decision-slug",
  "decision-duplicate",
  "decision-words",
  "decision-field",
  "decision-evidence",
  "decision-unenforced",
  "prime-lines",
  "memories-count",
  "memories-bytes",
  "file-lines",
  "unused-allowance",
] as const;
type BudgetsRule = (typeof BUDGETS_RULES)[number];

const violation = (rule: BudgetsRule, file: string, message: string, line?: number): Violation => ({
  check: "budgets",
  rule: `budgets/${rule}`,
  file,
  ...(line === undefined ? {} : { line }),
  message,
});

export interface Metrics {
  readonly agentsLines: number | undefined;
  readonly readmeLines: number | undefined;
  readonly decisions: number;
  readonly policyOnlyDecisions: number;
  readonly memories: number | undefined;
  readonly memoryBytes: number | undefined;
  /** Source files over the warning size, largest first. */
  readonly largeFiles: ReadonlyArray<{ readonly file: string; readonly lines: number }>;
}

export const measure = (config: ResolvedConfig, snapshot: Snapshot): Metrics => {
  const agents = snapshot.texts.get("AGENTS.md");
  const readme = snapshot.texts.get("README.md");
  const decisions = parseDecisions(snapshot.texts.get("DECISIONS.md") ?? "");
  const memories = snapshot.memories === undefined ? undefined : [...snapshot.memories.values()];
  const largeFiles = lineSources(snapshot, config.coverage.exempt)
    .map((file) => ({ file, lines: lineCount(snapshot.texts.get(file) ?? "") }))
    .filter((entry) => entry.lines > config.budgets.fileWarnLines)
    .sort((a, b) => b.lines - a.lines);
  return {
    agentsLines: agents === undefined ? undefined : lineCount(agents),
    readmeLines: readme === undefined ? undefined : lineCount(readme),
    decisions: decisions.length,
    policyOnlyDecisions: decisions.filter((d) => d.evidence === "policy").length,
    memories: memories?.length,
    memoryBytes: memories?.reduce((sum, text) => sum + new TextEncoder().encode(text).length, 0),
    largeFiles,
  };
};

export const checkBudgets = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const budgets = config.budgets;
  const metrics = measure(config, snapshot);
  const violations: Array<Violation> = [];

  if (metrics.agentsLines === undefined)
    violations.push(
      violation(
        "agents-missing",
        "AGENTS.md",
        "is missing: agents need commands, gotchas and decision authority somewhere",
      ),
    );
  else if (metrics.agentsLines > budgets.agentsLines)
    violations.push(
      violation(
        "agents-lines",
        "AGENTS.md",
        `has ${metrics.agentsLines} lines (budget ${budgets.agentsLines}). Turn a rule into a check, or delete what a check already enforces.`,
      ),
    );

  const prime = snapshot.texts.get(PRIME_FILE);
  if (prime !== undefined && lineCount(prime) > PRIME_LINES)
    violations.push(
      violation(
        "prime-lines",
        PRIME_FILE,
        `has ${lineCount(prime)} lines (budget ${PRIME_LINES}). bd prints it at every session start; move what only one step needs into that step's skill.`,
      ),
    );

  const claude = snapshot.texts.get("CLAUDE.md");
  if (claude !== undefined && claude.trim() !== "@AGENTS.md")
    violations.push(
      violation(
        "claude-md",
        "CLAUDE.md",
        "must contain only `@AGENTS.md`: one instruction source, not two",
      ),
    );

  if (metrics.readmeLines !== undefined && metrics.readmeLines > budgets.readmeLines)
    violations.push(
      violation(
        "readme-lines",
        "README.md",
        `has ${metrics.readmeLines} lines (budget ${budgets.readmeLines})`,
      ),
    );

  const decisions = parseDecisions(snapshot.texts.get("DECISIONS.md") ?? "");
  if (decisions.length > budgets.decisions)
    violations.push(
      violation(
        "decisions-count",
        "DECISIONS.md",
        `has ${decisions.length} entries (budget ${budgets.decisions}). Retire one: enforce it as a check and delete it, or drop it.`,
      ),
    );
  const index = pathIndex(snapshot.files);
  const seen = new Set<string>();
  for (const decision of decisions) {
    const at = (rule: BudgetsRule, message: string) =>
      violations.push(
        violation(rule, "DECISIONS.md", `${decision.slug} ${message}`, decision.line),
      );
    if (!SLUG.test(decision.slug)) at("decision-slug", "is not a slug like D-address-space");
    if (seen.has(decision.slug)) at("decision-duplicate", "appears twice");
    seen.add(decision.slug);
    if (decision.words > budgets.decisionWords)
      at(
        "decision-words",
        `has ${decision.words} words (budget ${budgets.decisionWords}). Overwrite it shorter; history lives in git.`,
      );
    for (const field of FIELDS)
      if (!decision.fields.has(field)) at("decision-field", `is missing "${field}:"`);
    if (
      decision.evidence !== undefined &&
      !(EVIDENCE_KINDS as ReadonlyArray<string>).includes(decision.evidence)
    )
      at(
        "decision-evidence",
        `has evidence '${decision.evidence}'; use measured, verified or policy`,
      );
    if (decision.evidence !== "policy" && decision.fields.has("Enforced by")) {
      if (decision.enforcedBy.length === 0)
        at(
          "decision-unenforced",
          'names nothing in "Enforced by". Point at the test or check, or mark the evidence policy.',
        );
      for (const path of decision.enforcedBy)
        if (!index.has(path.replace(/\/$/, "")))
          at("decision-unenforced", `is enforced by '${path}', which does not exist`);
    }
  }

  if (metrics.memories !== undefined && metrics.memories > budgets.memories)
    violations.push(
      violation(
        "memories-count",
        ".beads",
        `has ${metrics.memories} bd memories (budget ${budgets.memories}). Keep principles; move gotchas next to their checks.`,
      ),
    );
  if (metrics.memoryBytes !== undefined && metrics.memoryBytes > budgets.memoryBytes)
    violations.push(
      violation(
        "memories-bytes",
        ".beads",
        `bd memories total ${metrics.memoryBytes} bytes (budget ${budgets.memoryBytes})`,
      ),
    );

  const allowed = budgets.largeFiles;
  for (const { file, lines } of metrics.largeFiles)
    if (
      lines > budgets.fileFailLines &&
      !matchesAny(
        file,
        allowed.map((a) => a.path),
      )
    )
      violations.push(
        violation(
          "file-lines",
          file,
          `has ${lines} lines (budget ${budgets.fileFailLines}). Split it, or allow it in budgets.largeFiles with a reason.`,
        ),
      );
  for (const allowance of allowed)
    if (
      !metrics.largeFiles.some(
        (f) => f.lines > budgets.fileFailLines && matchesAny(f.file, [allowance.path]),
      )
    )
      violations.push(
        violation(
          "unused-allowance",
          "shape.config.ts",
          `budgets.largeFiles '${allowance.path}' allows nothing; delete it`,
        ),
      );
  return violations;
};
