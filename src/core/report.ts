/** Text output for the CLI. Violations sort by file and line so diffs between runs are stable. */
import type { Metrics } from "./budgets.ts";
import type { CheckRun } from "./check.ts";
import type { Outcome, Violation } from "./model.ts";
import type { RuleHatches } from "./rules/engine.ts";

/** Location and rule on one line (grep-able), the message indented below it (readable). */
export const formatViolation = (v: Violation): string =>
  `${v.file}${v.line === undefined ? "" : `:${v.line}`}  ${v.rule}\n  ${v.message}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const byLocation = (a: Violation, b: Violation): number =>
  a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule);

/** What follows a check's outcome on its line. */
const detail = (outcome: Outcome): string => {
  switch (outcome.state) {
    case "passed":
    case "failed":
      return outcome.examined;
    case "not-applicable":
    case "exempt":
      return outcome.reason;
    case "unavailable":
      return `${outcome.prerequisite}: ${outcome.reason}${outcome.required ? "" : " (optional)"}`;
  }
};

/**
 * Notes, then each finding, then one line per check (its outcome and what it examined), then
 * the summary, which is always the last line.
 */
export const formatCheck = ({ reports, result, notes }: CheckRun): string => {
  const entries = [...result.failing].sort(byLocation).map(formatViolation);
  for (const l of result.loose)
    entries.push(
      `${l.file}  ${l.rule}\n  ratchet is loose: baseline allows ${l.allowed}, found ${l.found}. Run \`mshape baseline --tighten\`.`,
    );
  const problems = result.failing.length + result.loose.length;
  const suffix =
    result.grandfathered > 0 ? `, ${result.grandfathered} grandfathered by the baseline` : "";
  const summary =
    problems === 0
      ? `mshape check passed${suffix}`
      : `mshape check failed: ${plural(problems, "problem")}${suffix}`;
  // Parts sit two columns deeper, so their labels count two longer: every state lines up.
  const width =
    Math.max(
      0,
      ...reports.flatMap((r) => [
        r.check.length,
        ...(r.parts ?? []).map((p) => p.label.length + 2),
      ]),
    ) + 2;
  const line = (label: string, outcome: Outcome, indent: number) =>
    `${label.padEnd(width - indent)}${outcome.state.padEnd(16)}${detail(outcome)}`;
  const lines = reports.flatMap((r) => [
    `  ${line(r.check, r.outcome, 0)}`,
    ...(r.parts ?? []).map((part) => `    ${line(part.label, part.outcome, 2)}`),
  ]);
  return [
    ...notes.map((note) => `note: ${note}`),
    [...entries, [...lines, "", summary].join("\n")].join("\n\n"),
  ].join("\n");
};

export interface GardenReport {
  readonly metrics: Metrics;
  readonly budgets: {
    readonly agentsLines: number;
    readonly readmeLines: number;
    readonly decisions: number;
    readonly memories: number;
    readonly memoryBytes: number;
  };
  readonly escapeHatches: {
    readonly shapeIgnores: number;
    readonly biomeIgnores: number;
    readonly allowances: number;
  };
  readonly ratcheted: number;
  /** Each local rule's own escape hatches, already counted in the totals above. */
  readonly localRules: ReadonlyArray<RuleHatches>;
}

const row = (label: string, value: number | undefined, cap?: number): string =>
  `  ${label.padEnd(28)}${value === undefined ? "n/a" : String(value)}${cap === undefined ? "" : ` / ${cap}`}`;

export const formatGarden = (g: GardenReport): string =>
  [
    "Budgets",
    row("AGENTS.md lines", g.metrics.agentsLines, g.budgets.agentsLines),
    row("README.md lines", g.metrics.readmeLines, g.budgets.readmeLines),
    row("decisions", g.metrics.decisions, g.budgets.decisions),
    row("  policy-only", g.metrics.policyOnlyDecisions),
    row("bd memories", g.metrics.memories, g.budgets.memories),
    row("bd memory bytes", g.metrics.memoryBytes, g.budgets.memoryBytes),
    "Escape hatches (review any growth)",
    row("shape-ignore comments", g.escapeHatches.shapeIgnores),
    row("biome-ignore comments", g.escapeHatches.biomeIgnores),
    row("config allowances", g.escapeHatches.allowances),
    ...(g.localRules.length === 0
      ? []
      : [
          "  Local rules",
          // As wide as the other rows, or as the longest id plus two: counts never run into it.
          ...g.localRules.map((r, _, all) => {
            const width = Math.max(26, ...all.map((each) => each.rule.length + 2));
            return `    ${r.rule.padEnd(width)}${plural(r.ignores, "ignore")}, ${plural(r.allowances, "allowance")}`;
          }),
        ]),
    row("ratcheted violations", g.ratcheted),
    `Large files (${g.metrics.largeFiles.length})`,
    ...g.metrics.largeFiles.slice(0, 15).map((f) => `  ${String(f.lines).padStart(6)}  ${f.file}`),
  ].join("\n");
