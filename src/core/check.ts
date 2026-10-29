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

/**
 * Rules that need data this machine may lack (bd isn't installed in CI). Their findings
 * can't be counted here, so a baseline entry for them must not read as a loose ratchet.
 */
export const unevaluated = (snapshot: Snapshot): ReadonlySet<string> =>
  new Set([
    ...(snapshot.beadIds === undefined ? ["refs/bead-in-code"] : []),
    ...(snapshot.memories === undefined
      ? ["budgets/memories-count", "budgets/memories-bytes"]
      : []),
  ]);

export const runChecks = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
): ReadonlyArray<Violation> => only.flatMap((name) => run[name](config, snapshot));
