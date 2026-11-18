/**
 * `mshape gate`: the repo's gate, from its config. Two phases, so `--fast` has one cut point:
 * fast is every pack's fast stages in `packs` order, then `mshape check`, then the repo's fast
 * stages; full is every pack's other stages, then the repo's. A repo stage with a pack stage's
 * name replaces it, in the pack stage's place and phase unless it says `fast`. The table and
 * its cases are plan/MILESTONE.md's; `test/core/gate.test.ts` holds them.
 */
import type { Pack } from "../packs/pack.ts";
import {
  CHECK_STAGE,
  type GateStage,
  type PackId,
  type ResolvedConfig,
} from "../schemas/config.ts";

export { CHECK_STAGE };

/** What the gate reads of each pack: its default stages and the programs it needs. */
export type GatePacks = Readonly<Partial<Record<PackId, Pick<Pack, "stages" | "prerequisites">>>>;

/**
 * Whether a stage's missing program fails it: as the repo's `prerequisites` sets that tool,
 * else as its pack declares it; a program the pack doesn't declare is required.
 */
const requiredHere = (
  config: Pick<ResolvedConfig, "prerequisites">,
  program: string | undefined,
  pack: Pick<Pack, "prerequisites">,
): boolean => {
  const prerequisite = pack.prerequisites.find((one) => one.name === program);
  if (prerequisite === undefined) return true;
  const setting = config.prerequisites[prerequisite.name];
  return setting === undefined ? prerequisite.required : setting === "required";
};

/** How to install a stage's missing program, from its pack's prerequisites. */
export const installHint = (
  packs: GatePacks,
  stage: Pick<PlannedStage, "origin" | "run">,
): string | undefined =>
  stage.origin === "mshape" || stage.origin === "repo"
    ? undefined
    : packs[stage.origin]?.prerequisites.find((one) => one.name === stage.run[0])?.install;

/** One stage as the gate runs it. */
export interface PlannedStage {
  readonly name: string;
  /** Empty for `mshape check`, which runs in-process. */
  readonly run: ReadonlyArray<string>;
  readonly fast: boolean;
  readonly okExit: ReadonlyArray<number>;
  /** Whose: a pack's (possibly replaced by the repo), `mshape`'s check, or the repo's own. */
  readonly origin: PackId | "mshape" | "repo";
  /** A missing program fails the stage; otherwise it is a note. Repo stages always are. */
  readonly required: boolean;
  /** A repo stage that took a pack stage's place. */
  readonly replaced: boolean;
}

const planned = (
  stage: GateStage,
  origin: PlannedStage["origin"],
  required: boolean,
  replaced: boolean,
  fast: boolean,
): PlannedStage => ({
  name: stage.name,
  run: stage.run,
  fast,
  okExit: stage.okExit ?? [0],
  origin,
  required,
  replaced,
});

/**
 * Every stage of the gate, fast phase first, in the order they run. `packs` is the registry
 * (`src/packs/index.ts`); a listed pack it lacks has no stages (loading the config refuses one).
 */
export const gateStages = (
  config: Pick<ResolvedConfig, "packs" | "gate" | "prerequisites">,
  packs: GatePacks,
): ReadonlyArray<PlannedStage> => {
  const own = new Map(config.gate.stages.map((stage) => [stage.name, stage]));
  const packStages = config.packs.flatMap((id) => {
    const pack = packs[id];
    if (pack === undefined) return [];
    return pack.stages.map((stage): PlannedStage => {
      const replacement = own.get(stage.name);
      const required = requiredHere(config, stage.run[0], pack);
      const fast = stage.fast ?? false;
      if (replacement === undefined) return planned(stage, id, required, false, fast);
      own.delete(stage.name);
      // The repo's stage is the repo's to keep working: its program is always required.
      return planned(replacement, id, true, true, replacement.fast ?? fast);
    });
  });
  const repoStages = [...own.values()].map((stage) =>
    planned(stage, "repo", true, false, stage.fast ?? false),
  );
  const check: PlannedStage = {
    name: CHECK_STAGE,
    run: [],
    fast: true,
    okExit: [0],
    origin: "mshape",
    required: true,
    replaced: false,
  };
  return [
    ...packStages.filter((stage) => stage.fast),
    check,
    ...repoStages.filter((stage) => stage.fast),
    ...packStages.filter((stage) => !stage.fast),
    ...repoStages.filter((stage) => !stage.fast),
  ];
};

/** How a stage ended. `note` is an optional prerequisite missing: it doesn't fail the gate. */
export type StageState = "passed" | "failed" | "skipped" | "note";

export interface StageResult {
  readonly stage: PlannedStage;
  readonly state: StageState;
  /** What the line says after the state: the command, or why it didn't run. */
  readonly detail: string;
  /** The stage's whole output, kept in the log; its tail is shown when it failed. */
  readonly log?: string;
}

/** How a stage's command reads, on one line whatever its arguments hold. */
export const stageCommand = (stage: PlannedStage): string =>
  stage.origin === "mshape" ? "mshape check" : stage.run.join(" ").replaceAll("\n", "\\n");

/** The lines of a failing stage's output shown inline; the log has the rest. */
export const TAIL_LINES = 40;

const tail = (output: string): string => {
  const lines = output.trimEnd().split("\n");
  return lines.length <= TAIL_LINES
    ? lines.join("\n")
    : [`… ${lines.length - TAIL_LINES} lines above, in the log`, ...lines.slice(-TAIL_LINES)].join(
        "\n",
      );
};

/**
 * Each failing stage's output tail under its name, then one line per stage, then the summary,
 * which is always the last line.
 */
export const formatGate = (
  results: ReadonlyArray<StageResult>,
  output: ReadonlyMap<string, string>,
  fastOnly: boolean,
): string => {
  const width = Math.max(...results.map((result) => result.stage.name.length)) + 2;
  const failed = results.filter((result) => result.state === "failed");
  const blocks = failed.map((result) => {
    const text = output.get(result.stage.name) ?? "";
    return [
      `── ${result.stage.name}: ${stageCommand(result.stage)}`,
      ...(text.trim() === "" ? [] : [tail(text)]),
      ...(result.log === undefined ? [] : [`(the whole output: ${result.log})`]),
    ].join("\n");
  });
  const lines = results.map(
    (result) => `  ${result.stage.name.padEnd(width)}${result.state.padEnd(10)}${result.detail}`,
  );
  // mshape check's notes say what it couldn't look at, so they show even when it passed.
  const notes = (output.get(CHECK_STAGE) ?? "")
    .split("\n")
    .filter((line) => line.startsWith("note: "));
  const ran = fastOnly ? "mshape gate --fast" : "mshape gate";
  const summary =
    failed.length === 0
      ? `${ran} passed`
      : `${ran} failed: ${failed.map((result) => result.stage.name).join(", ")}`;
  return [
    ...(notes.length > 0 && !failed.some((result) => result.stage.name === CHECK_STAGE)
      ? [notes.join("\n")]
      : []),
    ...blocks,
    [...lines, "", summary].join("\n"),
  ].join("\n\n");
};
