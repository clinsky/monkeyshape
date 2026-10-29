/** Runs the selected checks over a snapshot. Pure: the CLI loads, this decides. */
import type { ResolvedConfig } from "../schemas/config.ts";
import { checkArch } from "./arch.ts";
import { checkBudgets } from "./budgets.ts";
import { checkCoverage } from "./coverage.ts";
import type { CheckName, Snapshot, Violation } from "./model.ts";
import { checkRefs } from "./refs.ts";
import { checkRules } from "./rules/engine.ts";
import { RULES } from "./rules/registry.ts";

export const CHECKS: ReadonlyArray<CheckName> = ["arch", "refs", "budgets", "coverage", "rules"];

const run: Record<
  CheckName,
  (config: ResolvedConfig, snapshot: Snapshot) => ReadonlyArray<Violation>
> = {
  arch: checkArch,
  refs: checkRefs,
  budgets: checkBudgets,
  coverage: checkCoverage,
  rules: (config, snapshot) => checkRules(config, snapshot, RULES),
};

const BEADS_RULES = ["refs/bead-in-code", "budgets/memories-count", "budgets/memories-bytes"];

/**
 * Rules this run didn't evaluate: their check wasn't selected (`--only`), or they need data
 * this machine lacks (bd isn't installed in CI). Their findings weren't counted, so a
 * baseline entry for them must not read as a loose ratchet, nor be tightened away.
 */
export const unevaluated = (
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
  baselineRules: Iterable<string> = [],
): ReadonlySet<string> =>
  new Set([
    ...(snapshot.integrations.beads.state === "ok" ? [] : BEADS_RULES),
    ...[...baselineRules].filter(
      (rule) => !(only as ReadonlyArray<string>).includes(rule.split("/")[0] ?? ""),
    ),
  ]);

/** What this run could not do, said out loud so a green result has one meaning. */
export const notices = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const { beads, tsc, biome } = snapshot.integrations;
  if (beads.state === "unavailable" && config.beads === "optional")
    out.push(`skipped ${BEADS_RULES.join(", ")}: ${beads.reason}`);
  for (const [name, integration] of [
    ["tsc", tsc],
    ["biome", biome],
  ] as const)
    if (integration.state === "unavailable" || integration.state === "failed")
      out.push(
        `coverage approximated ${name}'s file list from its config (${integration.reason}): inheritance and project references are not resolved`,
      );
  return out;
};

export const runChecks = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
): ReadonlyArray<Violation> => only.flatMap((name) => run[name](config, snapshot));
