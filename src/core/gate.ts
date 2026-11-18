/**
 * `mshape gate`: the repo's gate, from its config. Two phases, so `--fast` has one cut point:
 * fast is every pack's fast stages in `packs` order, then `mshape check`, then the repo's fast
 * stages; full is every pack's other stages, then the repo's. A repo stage with a pack stage's
 * name replaces it, in the pack stage's place and phase unless it says `fast`. The table and
 * its cases are plan/MILESTONE.md's; `test/core/gate.test.ts` holds them.
 */
import type { GateStage, PackId, ResolvedConfig } from "../schemas/config.ts";

/** A pack's default stage, with whether its program is a required prerequisite of the pack. */
export interface PackStage {
  readonly name: string;
  readonly run: ReadonlyArray<string>;
  readonly fast: boolean;
  readonly okExit?: ReadonlyArray<number>;
  /** The `prerequisites` key that makes it optional; required when it has none. */
  readonly prerequisite?: "tsc" | "biome";
}

/**
 * Each pack's default stages: what a born repo's gate runs today, so migrating changes no
 * outcome. Unique names across packs, so a repo stage replaces exactly one.
 */
export const PACK_STAGES: Readonly<Record<PackId, ReadonlyArray<PackStage>>> = {
  typescript: [
    { name: "tsc", run: ["tsc", "-p", "."], fast: true, prerequisite: "tsc" },
    {
      name: "biome",
      run: ["biome", "ci", "--error-on-warnings", "."],
      fast: true,
      prerequisite: "biome",
    },
    { name: "bun-test", run: ["bun", "test", "--pass-with-no-tests"], fast: false },
  ],
  rust: [
    { name: "cargo-fmt", run: ["cargo", "fmt", "--all", "--check"], fast: true },
    {
      name: "clippy",
      run: ["cargo", "clippy", "--workspace", "--all-targets", "--", "-D", "warnings"],
      fast: true,
    },
    // cargo passes a workspace with no tests.
    { name: "cargo-test", run: ["cargo", "test", "--workspace"], fast: false },
  ],
  python: [
    { name: "ruff-format", run: ["uv", "run", "ruff", "format", "--check"], fast: true },
    { name: "ruff-check", run: ["uv", "run", "ruff", "check"], fast: true },
    { name: "ty", run: ["uv", "run", "ty", "check"], fast: true },
    // 5: pytest collected no tests, which a born repo has none of yet.
    { name: "pytest", run: ["uv", "run", "pytest"], fast: false, okExit: [0, 5] },
  ],
};

/** The stage that is `mshape check`, run in-process rather than spawned. */
export const CHECK_STAGE = "mshape-check";

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

/** Every stage of the gate, fast phase first, in the order they run. */
export const gateStages = (
  config: Pick<ResolvedConfig, "packs" | "gate" | "prerequisites">,
): ReadonlyArray<PlannedStage> => {
  const own = new Map(config.gate.stages.map((stage) => [stage.name, stage]));
  const packStages = config.packs.flatMap((pack) =>
    PACK_STAGES[pack].map((stage): PlannedStage => {
      const replacement = own.get(stage.name);
      const required =
        stage.prerequisite === undefined || config.prerequisites[stage.prerequisite] === "required";
      if (replacement === undefined) return planned(stage, pack, required, false, stage.fast);
      own.delete(stage.name);
      // The repo's stage is the repo's to keep working: its program is always required.
      return planned(replacement, pack, true, true, replacement.fast ?? stage.fast);
    }),
  );
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
  stage.name === CHECK_STAGE ? "mshape check" : stage.run.join(" ").replaceAll("\n", "\\n");

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
