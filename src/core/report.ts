/** Text output for the CLI. Violations sort by file and line so diffs between runs are stable. */
import type { Metrics } from "./budgets.ts";
import type { Violation } from "./model.ts";
import type { RatchetResult } from "./ratchet.ts";

export const formatViolation = (v: Violation): string =>
  `${v.file}${v.line === undefined ? "" : `:${v.line}`}  ${v.rule}  ${v.message}`;

const byLocation = (a: Violation, b: Violation): number =>
  a.file.localeCompare(b.file) || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule);

export const formatCheck = (result: RatchetResult): string => {
  const lines = [...result.failing].sort(byLocation).map(formatViolation);
  for (const l of result.loose)
    lines.push(
      `${l.file}  ${l.rule}  ratchet is loose: baseline allows ${l.allowed}, found ${l.found}. Run \`mshape baseline --tighten\`.`,
    );
  const problems = result.failing.length + result.loose.length;
  const suffix =
    result.grandfathered > 0 ? `, ${result.grandfathered} grandfathered by the baseline` : "";
  lines.push(
    problems === 0
      ? `mshape check passed${suffix}`
      : `\nmshape check failed: ${problems} problem(s)${suffix}`,
  );
  return lines.join("\n");
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
    row("ratcheted violations", g.ratcheted),
    `Large files (${g.metrics.largeFiles.length})`,
    ...g.metrics.largeFiles.slice(0, 15).map((f) => `  ${String(f.lines).padStart(6)}  ${f.file}`),
  ].join("\n");
