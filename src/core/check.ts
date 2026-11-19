/** Runs the selected checks over a snapshot. Pure: the CLI loads, this decides. */

import type { Pack } from "../packs/pack.ts";
import { CHECK_NAMES, type ResolvedConfig } from "../schemas/config.ts";
import { ARCH_RULES, archFiles, checkArch } from "./arch.ts";
import { BEADS_RULES, checkBeads } from "./beads.ts";
import { BUDGETS_RULES, checkBudgets } from "./budgets.ts";
import {
  COVERAGE_RULES,
  checkCoverage,
  commandReports,
  dataFiles,
  executableSources,
  withoutTools,
} from "./coverage.ts";
import { checkFiles, FILES_RULES, formatBytes, heldFiles } from "./files.ts";
import { settablePrerequisites } from "./gate.ts";
import { matchesAny } from "./glob.ts";
import { SKILLS_DIR, SKILLS_MANIFEST } from "./layout.ts";
import {
  type CheckName,
  type CheckReport,
  type Integration,
  lineSources,
  type Outcome,
  type Snapshot,
  type Violation,
} from "./model.ts";
import { checkPacks, PACKS_RULES, packRuleIds } from "./packs.ts";
import { applyBaseline, type Counts, type RatchetResult } from "./ratchet.ts";
import { checkRefs, REFS_RULES } from "./refs.ts";
import { checkRules, ENGINE_RULES, type Rule } from "./rules/engine.ts";
import { RULES } from "./rules/registry.ts";
import { checkSkills, SKILLS_RULES } from "./skills.ts";
import {
  checkSources,
  claimOf,
  inSources,
  type Place,
  places,
  SOURCES_RULES,
  toCover,
} from "./sources.ts";
import { checkSync, SYNC_RULES } from "./sync.ts";

export const CHECKS: ReadonlyArray<CheckName> = CHECK_NAMES;

const run: Record<
  CheckName,
  (config: ResolvedConfig, snapshot: Snapshot) => ReadonlyArray<Violation>
> = {
  arch: checkArch,
  sources: checkSources,
  refs: checkRefs,
  budgets: checkBudgets,
  coverage: checkCoverage,
  files: checkFiles,
  rules: (config, snapshot) => checkRules(config, snapshot),
  packs: checkPacks,
  skills: checkSkills,
  sync: checkSync,
  beads: checkBeads,
};

/** The rules bd's memories feed: no export holds them, so without bd they're skipped. */
const NEEDS_MEMORIES = ["budgets/memories-count", "budgets/memories-bytes"];

/** The rules that need bd: where it can't run, they're skipped with a notice. */
const NEEDS_BD = [
  "refs/bead-in-code",
  ...NEEDS_MEMORIES,
  // An unreadable export is reported where bd is missing, so that kind never waits on bd.
  ...BEADS_RULES.filter((kind) => kind !== "export-unreadable").map((kind) => `beads/${kind}`),
];

/** Whether the beads came from the committed export, bd being unavailable here. */
const fromExport = (snapshot: Snapshot): boolean =>
  snapshot.integrations.beads.state === "unavailable" && snapshot.beadsExport?.state === "read";

/** The rules this run couldn't evaluate for want of bd. */
const withoutBd = (snapshot: Snapshot): ReadonlyArray<string> =>
  snapshot.integrations.beads.state === "ok"
    ? []
    : fromExport(snapshot)
      ? NEEDS_MEMORIES
      : NEEDS_BD;

/** A tool a check asks, how it fared, and whether the config lets the check go without it. */
interface Prerequisite {
  readonly name: string;
  readonly integration: Integration;
  readonly required: boolean;
  /** How to install it, when it is a pack's tool. */
  readonly install?: string;
  /** Whether coverage can read the tool's config in its place, when it is optional. */
  readonly approximates?: boolean;
}

/**
 * How to make a tool optional, where the config can say so and coverage can then read the
 * tool's config in its place; nothing where either is false, so the fix is only to install it.
 */
const optionalHint = (
  config: ResolvedConfig,
  settable: ReadonlySet<string>,
  name: string,
  approximates: boolean,
): string => {
  if (!approximates || !settable.has(name)) return "";
  return `, or set \`${name} = "optional"\` under \`[prerequisites]\` in ${config.configFile} to read its config instead`;
};

const NOT_LOADED: Integration = { state: "unavailable", reason: "its pack's loader didn't run it" };

/**
 * Each tool of a pack with files to cover, how its run fared, and whether it is required: as
 * `prerequisites` in the config says, else as its pack does.
 */
const packTools = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Prerequisite> =>
  snapshot.packs.flatMap((loaded) =>
    toCover(config, snapshot, loaded).length === 0
      ? []
      : loaded.pack.tools.map((tool) => {
          const declared = loaded.pack.prerequisites.find((p) => p.name === tool.name);
          const setting = config.prerequisites[tool.name];
          return {
            name: tool.name,
            integration:
              loaded.load.tools.find((run) => run.tool === tool.name)?.integration ?? NOT_LOADED,
            required: setting === undefined ? (declared?.required ?? true) : setting === "required",
            ...(declared === undefined ? {} : { install: declared.install }),
            approximates: tool.approximate !== undefined,
          };
        }),
  );

/**
 * What each check can't run without. A failed tool fails the gate whatever the config says;
 * an unavailable one fails it when required. coverage alone can do without its tools, by
 * reading their configs, so an optional tool it lacks is a note, not a gap.
 */
const prerequisitesOf = (
  check: CheckName,
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Prerequisite> => {
  const { beads } = snapshot.integrations;
  // A pack's tools cover its files: a pack with none to cover doesn't need them.
  if (check === "coverage") return packTools(config, snapshot);
  // The export stands in for an unavailable bd, unless the config requires bd itself.
  if (check === "beads" && snapshot.beadsExport !== undefined && config.beads === "optional")
    return beads.state === "unavailable"
      ? []
      : [{ name: "bd", integration: beads, required: false }];
  if (check === "beads")
    return [{ name: "bd", integration: beads, required: config.beads === "required" }];
  // The repo's own rules run on ast-grep: without it they can't say anything, so it's required.
  // Its reason says what didn't run: every rule, monkeyshape's own too, not only the repo's.
  if (check === "rules" && snapshot.shapeRules !== undefined) {
    const integration = snapshot.shapeRules.integration;
    return [
      {
        name: "ast-grep",
        integration:
          integration.state === "unavailable"
            ? {
                ...integration,
                reason: `${integration.reason}. It runs this repo's shape-rules/, so no rule ran, monkeyshape's own included`,
              }
            : integration,
        required: true,
      },
    ];
  }
  return [];
};

/** The first prerequisite that stops `check` from saying anything true, if any. */
const blocker = (
  check: CheckName,
  config: ResolvedConfig,
  snapshot: Snapshot,
): Extract<Outcome, { state: "unavailable" }> | undefined => {
  for (const { name, integration, required } of prerequisitesOf(check, config, snapshot)) {
    if (integration.state === "failed")
      return {
        state: "unavailable",
        prerequisite: name,
        reason: integration.reason,
        required: true,
      };
    if (integration.state === "unavailable" && (required || check !== "coverage"))
      return { state: "unavailable", prerequisite: name, reason: integration.reason, required };
    if (integration.state === "absent" && required)
      return {
        state: "unavailable",
        prerequisite: name,
        reason: "the repo has no .beads/config.yaml",
        required,
      };
  }
  return undefined;
};

/** The listed packs' languages, for what a check looked at: "TypeScript", "Rust or Python". */
const language = (snapshot: Snapshot): string =>
  snapshot.packs.map(({ pack }) => pack.language).join(" or ") || "language source";

const plural = (n: number, word: string, many = `${word}s`): string =>
  `${n} ${n === 1 ? word : many}`;

/** What a check ran over, in words, or why there was nothing for it to look at. */
type Scope = { readonly examined: string } | { readonly notApplicable: string };

const scopeOf = (check: CheckName, config: ResolvedConfig, snapshot: Snapshot): Scope => {
  const typescript = places(config, snapshot);
  const code = snapshot.files.filter((file) => claimOf(snapshot, file)?.kind === "source");
  switch (check) {
    case "arch": {
      const arch = config.arch;
      if (arch === undefined)
        return code.length === 0
          ? { notApplicable: `no ${language(snapshot)} source, and no module map` }
          : { examined: "no module map" };
      const files = archFiles(config, snapshot);
      return files.length === 0
        ? {
            notApplicable: `no ${language(snapshot)} source under ${arch.root === "." ? "the repo root" : `${arch.root}/`}`,
          }
        : {
            examined: `${plural(files.length, "file")} in ${plural(Object.keys(arch.modules).length, "module")}`,
          };
    }
    case "sources": {
      if (typescript.length === 0) return { notApplicable: `no ${language(snapshot)} file` };
      const count = (kind: Place["kind"]) =>
        typescript.filter(({ place }) => place.kind === kind).length;
      const parts = [
        `${count("source")} in sources`,
        count("test") > 0 ? plural(count("test"), "test") : "",
        count("declaration") > 0 ? plural(count("declaration"), "declaration") : "",
        count("exempt") > 0 ? `${count("exempt")} exempt` : "",
        count("outside") > 0 ? `${count("outside")} outside` : "",
      ].filter(Boolean);
      return {
        examined: `${plural(typescript.length, `${language(snapshot)} file`)}: ${parts.join(", ")}`,
      };
    }
    case "rules": {
      // What the rules ran over: files in sources a listed pack reads. The rest are
      // `sources/unclaimed`.
      const files = snapshot.files.filter(
        (file) => inSources(config, file) && claimOf(snapshot, file) !== undefined,
      );
      const outside = typescript.filter(({ place }) => place.kind === "outside").length;
      // not-applicable means there is no source in a listed pack, never that sources missed it.
      return files.length === 0 && outside === 0
        ? { notApplicable: `no ${language(snapshot)} source` }
        : {
            examined: `${plural(files.length, "file")} in sources${outside > 0 ? `; ${outside} ${language(snapshot)} outside it, not analyzed` : ""}`,
          };
    }
    case "refs": {
      const docs = snapshot.files.filter((file) =>
        matchesAny(file, [...config.refs.docs, ...config.refs.formOnlyDocs]),
      );
      return { examined: `${plural(docs.length, "doc")}, and comments in ${language(snapshot)}` };
    }
    case "budgets": {
      const other = lineSources(snapshot, config.coverage.exempt).filter(
        (file) => claimOf(snapshot, file) === undefined,
      ).length;
      return {
        // Lengths first, so the count reads right for one file and for many.
        examined: `lengths of the loaded docs, decisions, memories, ${plural(typescript.length, `${language(snapshot)} file`)}${other === 0 ? "" : ` and ${plural(other, "other source file")}`}`,
      };
    }
    case "coverage": {
      const covered = snapshot.packs.flatMap((loaded) => {
        const files = toCover(config, snapshot, loaded);
        if (files.length === 0) return [];
        const tools = loaded.pack.tools.map((tool) => tool.name);
        const guessed = tools.filter(
          (tool) => loaded.load.tools.find((run) => run.tool === tool)?.integration.state !== "ok",
        );
        const own =
          tools.length === 1
            ? `${tools[0]}'s own file list`
            : `${tools.map((tool) => `${tool}'s`).join(" and ")} own file lists`;
        return [
          `${plural(files.length, `${loaded.pack.language} file`)} against ${guessed.length === 0 ? own : `${tools.join(" and ")}, ${guessed.join(" and ")} read from its config`}`,
        ];
      });
      const other = executableSources(config, snapshot).length;
      const commands = config.coverage.commands.length;
      const data = dataFiles(config, snapshot).length;
      const parts = [
        ...covered,
        ...(other + commands === 0
          ? []
          : [
              `${plural(other, "other source file")} against ${plural(commands, "declared command")}`,
            ]),
        ...(data === 0 ? [] : [`${plural(data, "data file")} parsed`]),
      ];
      return parts.length === 0
        ? { notApplicable: `no ${language(snapshot)}, other source or data file` }
        : { examined: parts.join("; ") };
    }
    case "packs": {
      const own = snapshot.packs.filter(({ pack }) => pack.findingKinds.length > 0);
      const ids = snapshot.packs.map(({ pack }) => pack.id).join(", ");
      return own.length === 0
        ? { notApplicable: `${ids === "" ? "no listed pack" : ids} has no checks of its own` }
        : { examined: `${own.map(({ pack }) => pack.id).join(" and ")}'s own checks` };
    }
    case "skills": {
      const { link, installed } = snapshot.skills;
      // A skill is a directory; the manifest beside them is sync's record, not a skill.
      const skills = new Set(
        [...installed.keys()]
          .filter((path) => path.includes("/"))
          .map((path) => path.split("/")[0]),
      );
      return link.kind === "missing" && installed.size === 0
        ? { notApplicable: "no installed skills" }
        : { examined: plural(skills.size, "installed skill") };
    }
    case "files": {
      const vendored = config.files.vendored.length;
      return {
        examined: `${plural(heldFiles(snapshot).length, "file")} against the ${formatBytes(config.files.maxBytes)} cap${vendored === 0 ? "" : `, ${plural(vendored, "vendored artifact")}`}`,
      };
    }
    case "sync":
      // Only a repo with sync's manifest is held to it (`checkSync`): elsewhere nothing was examined.
      return snapshot.skills.installed.has(SKILLS_MANIFEST)
        ? { examined: "PRIME.md, the PR template and the hook settings" }
        : { notApplicable: `sync has not run here: no ${SKILLS_DIR}/${SKILLS_MANIFEST}` };
    case "beads":
      return snapshot.integrations.beads.state === "absent"
        ? { notApplicable: "no .beads/" }
        : {
            examined: `${plural(snapshot.beadRows?.length ?? 0, "bead")}${snapshot.integrations.beads.state !== "ok" && snapshot.beadsExport !== undefined ? `, from the export (${snapshot.beadsExport.path})` : ""}`,
          };
  }
};

/**
 * One check, before the baseline: its violations, and an outcome that is final unless it
 * ran. A check that ran gets `failed` here when it found anything; `assess` settles it.
 */
export const report = (
  check: CheckName,
  config: ResolvedConfig,
  snapshot: Snapshot,
): CheckReport => {
  const off = config.checks[check]?.off;
  if (off !== undefined)
    return { check, outcome: { state: "exempt", reason: off }, violations: [] };
  const blocked = blocker(check, config, snapshot);
  if (blocked !== undefined) {
    // What needs neither tsc nor biome still shows under the blocked check (uncovered
    // source, each command's line and error), so the reader can fix it before installing them.
    const coverage = check === "coverage";
    const parts = coverage ? commandReports(config, snapshot) : [];
    return {
      check,
      outcome: blocked,
      violations: coverage ? withoutTools(config, snapshot) : [],
      ...(parts.length === 0 ? {} : { parts }),
    };
  }
  const violations = run[check](config, snapshot);
  const scope = scopeOf(check, config, snapshot);
  const examined = "examined" in scope ? scope.examined : scope.notApplicable;
  const parts = check === "coverage" ? commandReports(config, snapshot) : [];
  return {
    check,
    violations,
    ...(parts.length === 0 ? {} : { parts }),
    outcome:
      violations.length > 0
        ? { state: "failed", examined }
        : "examined" in scope
          ? { state: "passed", examined }
          : { state: "not-applicable", reason: scope.notApplicable },
  };
};

/**
 * Rules this run didn't evaluate: their check wasn't selected (`--only`), is exempt, or
 * couldn't run here (bd isn't installed in CI). Their findings weren't counted, so a
 * baseline entry for them must not read as a loose ratchet, nor be tightened away.
 */
export const unevaluated = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
  baselineRules: Iterable<string> = [],
): ReadonlySet<string> =>
  unevaluatedBy(
    only.filter(
      (check) =>
        config.checks[check] === undefined && blocker(check, config, snapshot) === undefined,
    ),
    snapshot,
    baselineRules,
  );

/** What `report` decided ran; `unevaluated` and `evaluate` both derive the set from it. */
const unevaluatedBy = (
  ran: ReadonlyArray<CheckName>,
  snapshot: Snapshot,
  baselineRules: Iterable<string>,
): ReadonlySet<string> =>
  // Every id a check that didn't run could report, not only those the caller's baseline
  // names: `tighten` must keep a turned-off check's entries whoever calls it.
  new Set([
    ...withoutBd(snapshot),
    ...[
      ...ruleIds(RULES, [...snapshot.packs.map(({ pack }) => pack), ...snapshot.otherPacks]),
      ...baselineRules,
    ]
      .filter((rule) => !rule.startsWith("prerequisites/"))
      .filter((rule) => !(ran as ReadonlyArray<string>).includes(rule.split("/")[0] ?? "")),
  ]);

const didRun = (r: CheckReport): boolean =>
  r.outcome.state !== "exempt" && r.outcome.state !== "unavailable";

/**
 * One pass over the selected checks: their reports, every violation, and the rules no check
 * evaluated. `assess` and `mshape baseline` both read it, so whether a check ran is decided
 * in one place, by its report.
 */
export const evaluate = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
  baselineRules: Iterable<string> = [],
) => {
  const reports = only.map((check) => report(check, config, snapshot));
  return {
    reports,
    violations: reports.flatMap((r) => r.violations),
    unevaluated: unevaluatedBy(
      reports.filter(didRun).map((r) => r.check),
      snapshot,
      baselineRules,
    ),
  };
};

/** What this run could not do, said out loud so a green result has one meaning. */
export const notices = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
): ReadonlyArray<string> => {
  const out: Array<string> = [];
  const { beads } = snapshot.integrations;
  if (beads.state === "unavailable" && config.beads === "optional")
    out.push(
      fromExport(snapshot)
        ? `read beads from the export, ${snapshot.beadsExport?.path}, and skipped ${NEEDS_MEMORIES.join(", ")}, which it doesn't hold: ${beads.reason}`
        : `skipped ${withoutBd(snapshot).join(", ")}: ${beads.reason}`,
    );
  if (only.includes("coverage") && config.checks.coverage === undefined)
    for (const { tool: name, integration } of snapshot.packs.flatMap(({ load }) => load.tools))
      if (integration.state === "unavailable" && config.prerequisites[name] === "optional")
        out.push(
          `coverage approximated ${name}'s file list from its config (${integration.reason}): inheritance and project references are not resolved`,
        );
  if (only.includes("coverage") && config.checks.coverage === undefined)
    for (const { label, outcome } of commandReports(config, snapshot))
      if (outcome.state === "unavailable" && !outcome.required)
        out.push(`skipped optional command \`${label}\`: ${outcome.reason}`);
  return out;
};

const PREREQUISITE_RULES = [
  "beads-failed",
  "beads-required",
  "tool-failed",
  "tool-unavailable",
] as const;

/**
 * The kinds each check reports, as its `violation` helper types them. Total over the checks,
 * so a new check doesn't compile until its kinds are listed here; registry rules add theirs
 * under `rules` in `ruleIds`.
 */
const KINDS: { readonly [C in Violation["check"]]: ReadonlyArray<string> } = {
  arch: ARCH_RULES,
  sources: SOURCES_RULES,
  refs: REFS_RULES,
  budgets: BUDGETS_RULES,
  coverage: COVERAGE_RULES,
  files: FILES_RULES,
  rules: ENGINE_RULES,
  // Beside each pack's own, which `ruleIds` adds from the packs it is given.
  packs: PACKS_RULES,
  skills: SKILLS_RULES,
  sync: SYNC_RULES,
  beads: BEADS_RULES,
  prerequisites: PREREQUISITE_RULES,
};

/**
 * Every rule id `mshape check` can report, namespaced as violations carry it: each check's own
 * kinds, one per registry rule, and each given pack's kinds. test/core/ruleCases.test.ts holds a
 * case that must fail and one that must pass for each, so a new id can't land without both.
 */
export const ruleIds = (
  rules: ReadonlyArray<Rule> = RULES,
  packs: ReadonlyArray<Pack> = [],
): ReadonlyArray<string> => [
  ...Object.entries(KINDS).flatMap(([check, kinds]) => kinds.map((kind) => `${check}/${kind}`)),
  ...rules.map((rule) => `rules/${rule.id}`),
  ...packRuleIds(packs),
];

const prerequisite = (
  rule: (typeof PREREQUISITE_RULES)[number],
  message: string,
  file = ".beads",
): Violation => ({
  check: "prerequisites",
  rule: `prerequisites/${rule}`,
  file,
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
 * Integrations that must work for a result to mean anything: bd failing outright, bd
 * unavailable when `beads: "required"`, or a tool a selected check asks failing or missing
 * when required. These are facts about the environment, not the code, so no baseline can
 * accept them; bd's apply whatever `--only` selects, a tool's only to the check that asks it.
 */
export const prerequisites = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
): ReadonlyArray<Violation> => {
  const out: Array<Violation> = [];
  const beads = snapshot.integrations.beads;
  const blocker = beadsBlocker(config.beads, beads);
  if (blocker === "failed" && beads.state === "failed")
    out.push(
      prerequisite("beads-failed", `bd failed, so beads checks did not run: ${beads.reason}`),
    );
  if (blocker === "required" && beads.state !== "ok")
    out.push(
      prerequisite(
        "beads-required",
        beads.state === "absent"
          ? `${config.configFile} requires beads, but the repo has no .beads/config.yaml`
          : `${config.configFile} requires beads, but ${beads.reason}`,
      ),
    );
  for (const check of only.filter((check) => config.checks[check] === undefined))
    for (const { name, integration, required, install, approximates } of prerequisitesOf(
      check,
      config,
      snapshot,
    )) {
      if (name === "bd") continue;
      const fix = `${install ?? `\`${name}\``}${optionalHint(config, settablePrerequisites(snapshot.packs.map((loaded) => loaded.pack)), name, approximates === true)}`;
      if (integration.state === "failed")
        out.push(
          prerequisite(
            "tool-failed",
            `${check} asks ${name}, which ran and failed: ${integration.reason}. Run it by hand to see why, and fix its config.`,
            name,
          ),
        );
      else if (integration.state === "unavailable" && required)
        out.push(
          prerequisite(
            "tool-unavailable",
            integration.fix === undefined
              ? `${check} needs ${name}, but ${integration.reason}. Install it (${fix}).`
              : `${check} needs ${name}, but ${integration.reason}. ${integration.fix}`,
            name,
          ),
        );
    }
  return out;
};

/** Every selected check's violations, before the baseline. */
export const runChecks = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  only: ReadonlyArray<CheckName> = CHECKS,
): ReadonlyArray<Violation> => only.flatMap((name) => report(name, config, snapshot).violations);

/** One `mshape check`: each check's settled report, the ratchet's result, and the notes. */
export interface CheckRun {
  readonly reports: ReadonlyArray<CheckReport>;
  readonly result: RatchetResult;
  readonly notes: ReadonlyArray<string>;
  readonly green: boolean;
}

/**
 * Runs the selected checks and settles each one's outcome after the baseline: a check whose
 * every finding is grandfathered passed; one with a new finding, or a loose ratchet, failed.
 */
export const assess = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  baseline: Counts = {},
  only: ReadonlyArray<CheckName> = CHECKS,
): CheckRun => {
  const {
    reports,
    violations,
    unevaluated: skipped,
  } = evaluate(config, snapshot, only, Object.keys(baseline));
  const ratcheted = applyBaseline(violations, baseline, skipped, snapshot.changedLines);
  const result = {
    ...ratcheted,
    failing: [...prerequisites(config, snapshot, only), ...ratcheted.failing],
  };
  const settled = reports.map((r): CheckReport => {
    if (r.outcome.state !== "failed") return r;
    const open =
      ratcheted.failing.some((v) => v.check === r.check) ||
      ratcheted.loose.some((l) => l.rule.startsWith(`${r.check}/`));
    return open ? r : { ...r, outcome: { state: "passed", examined: r.outcome.examined } };
  });
  return {
    reports: settled,
    result,
    notes: notices(config, snapshot, only),
    green: result.failing.length + result.loose.length === 0,
  };
};
