/** Runs the selected checks over a snapshot. Pure: the CLI loads, this decides. */
import type { ResolvedConfig } from "../schemas/config.ts";
import { checkArch } from "./arch.ts";
import { checkBudgets } from "./budgets.ts";
import { checkCoverage } from "./coverage.ts";
import type { CheckName, Integration, Snapshot, Violation } from "./model.ts";
import { checkRefs } from "./refs.ts";
import { checkRules } from "./rules/engine.ts";
import { RULES } from "./rules/registry.ts";
import { checkSkills } from "./skills.ts";

export const CHECKS: ReadonlyArray<CheckName> = [
  "arch",
  "refs",
  "budgets",
  "coverage",
  "rules",
  "skills",
];

const run: Record<
  CheckName,
  (config: ResolvedConfig, snapshot: Snapshot) => ReadonlyArray<Violation>
> = {
  arch: checkArch,
  refs: checkRefs,
  budgets: checkBudgets,
  coverage: checkCoverage,
  rules: (config, snapshot) => checkRules(config, snapshot, RULES),
  skills: checkSkills,
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

const prerequisite = (rule: string, message: string): Violation => ({
  check: "prerequisites",
  rule: `prerequisites/${rule}`,
  file: ".beads",
  message,
});

/**
 * When beads can't be trusted, whatever asks it: `failed` when bd ran and failed, whatever the
 * config says; `required` when `beads: "required"` and beads isn't ok. `check` and
 * `track rm` both decide with this, so a beads failure means one thing everywhere.
 */
export const beadsBlocker = (
  setting: ResolvedConfig["beads"],
  beads: Integration,
): "failed" | "required" | undefined =>
  beads.state === "failed"
    ? "failed"
    : setting === "required" && beads.state !== "ok"
      ? "required"
      : undefined;

/**
 * Integrations that must work for a result to mean anything: bd failing outright, or bd
 * unavailable when `beads: "required"`. These are facts about the environment, not the code,
 * so no baseline can accept them and no `--only` selection skips them.
 */
export const prerequisites = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const beads = snapshot.integrations.beads;
  const blocker = beadsBlocker(config.beads, beads);
  if (blocker === "failed" && beads.state === "failed")
    return [
      prerequisite("beads-failed", `bd failed, so beads checks did not run: ${beads.reason}`),
    ];
  if (blocker === "required" && beads.state !== "ok")
    return [
      prerequisite(
        "beads-required",
        beads.state === "absent"
          ? "shape.config.ts requires beads, but the repo has no .beads/config.yaml"
          : `shape.config.ts requires beads, but ${beads.reason}`,
      ),
    ];
  return [];
};

export const runChecks = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
): ReadonlyArray<Violation> => only.flatMap((name) => run[name](config, snapshot));
