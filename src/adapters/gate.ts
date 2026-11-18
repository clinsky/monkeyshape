/**
 * Runs `mshape gate`: each stage `gateStages` plans, one after another, a failure never
 * stopping the ones after it. Each run stage's whole output is kept in a log under the git
 * common directory, so a failure shows its tail and points at the rest.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import {
  formatGate,
  type GatePacks,
  gateStages,
  installHint,
  type PlannedStage,
  type StageResult,
  stageCommand,
} from "../core/gate.ts";
import { PACKS } from "../packs/index.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import { localBin } from "./packs/typescript.ts";
import { BUN_MISSING, bunPath, runTool } from "./process.ts";

/**
 * Where a stage's output is kept: under the git common dir, which outlives any worktree (track
 * pr gates a scratch checkout, then removes it), in a directory named for the checkout, so
 * tracks never share one. Outside git, a temp directory named for the root.
 */
export const gateLogDir = (root: string) =>
  Effect.map(
    runTool(root, [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
      "--show-toplevel",
    ]),
    (got) => {
      const [common, top] = got.stdout.trim().split("\n");
      return got.code === 0 && common !== undefined && top !== undefined
        ? join(common, "monkeyshape", "gate", basename(top))
        : join(tmpdir(), `mshape-gate-${Bun.hash(resolve(root)).toString(16)}`);
    },
  );

/** A stage's argv as it can be spawned, or why it can't be (undefined: the program isn't here). */
type Command = { readonly argv: ReadonlyArray<string> } | { readonly why: string | undefined };

/**
 * `bun` is Bun (`bunPath`). A tool in node_modules/.bin (the worktree's, else the main
 * checkout's) runs through Bun too, since its shim starts with `#!/usr/bin/env node`. Anything
 * else, from the PATH.
 */
const command = (root: string, run: ReadonlyArray<string>, path: string | undefined) =>
  Effect.gen(function* () {
    const [program, ...rest] = run;
    if (program === undefined) return { why: undefined } satisfies Command as Command;
    if (program === "bun") {
      const bun = bunPath();
      return (bun === undefined ? { why: BUN_MISSING } : { argv: [bun, ...rest] }) as Command;
    }
    // A path, such as `./scripts/check.sh`: there or not, from the repo root.
    if (program.includes("/"))
      return (
        (yield* Effect.promise(() => Bun.file(resolve(root, program)).exists()))
          ? { argv: run }
          : { why: undefined }
      ) as Command;
    const bin = yield* localBin(root, program, program);
    if (typeof bin !== "string") return { argv: [...bin, ...rest] } as Command;
    if (bin === BUN_MISSING) return { why: BUN_MISSING } as Command;
    return (
      Bun.which(program, path === undefined ? {} : { PATH: path }) === null
        ? { why: undefined }
        : { argv: run }
    ) as Command;
  });

const missing = (packs: GatePacks, stage: PlannedStage, why: string | undefined): string => {
  const program = stage.run[0] ?? "";
  const absent =
    why ?? `\`${program}\` isn't installed here (not in node_modules/.bin or on the PATH)`;
  if (stage.origin === "repo" || stage.replaced)
    return `${absent}, and this repo's gate stage \`${stage.name}\` needs it: install it, or change the stage in [gate].stages`;
  const hint = installHint(packs, stage);
  return stage.required
    ? `${absent}: the ${stage.origin} pack requires it${hint === undefined ? "" : `. Install it: ${hint}`}`
    : `${absent}, and \`prerequisites\` makes it optional: \`${stage.name}\` didn't run`;
};

export interface GateRun {
  readonly output: string;
  readonly code: number;
}

/**
 * The gate on `root`. `check` is `mshape check` on the same config, run in-process by the
 * caller, so it is the same check whichever `mshape` runs the gate.
 */
export const runGate = (
  root: string,
  config: ResolvedConfig,
  options: {
    readonly fast: boolean;
    readonly check: Effect.Effect<GateRun, unknown>;
    /** Where to look for programs, instead of the PATH: for tests. */
    readonly path?: string;
    /** The packs' stages and prerequisites, instead of the registry: for tests. */
    readonly packs?: GatePacks;
  },
) =>
  Effect.gen(function* () {
    const dir = yield* gateLogDir(root);
    yield* Effect.promise(() => mkdir(dir, { recursive: true }));
    const results: Array<StageResult> = [];
    const output = new Map<string, string>();
    const packs = options.packs ?? PACKS;
    for (const stage of gateStages(config, packs)) {
      const shown = stageCommand(stage);
      if (options.fast && !stage.fast) {
        results.push({ stage, state: "skipped", detail: `${shown} (--fast runs the fast phase)` });
        continue;
      }
      let ran: GateRun;
      if (stage.origin === "mshape")
        ran = yield* options.check.pipe(
          Effect.catch((error) =>
            Effect.succeed({ output: `mshape check couldn't run: ${String(error)}`, code: 1 }),
          ),
        );
      else {
        const found = yield* command(root, stage.run, options.path);
        if (!("argv" in found)) {
          results.push({
            stage,
            state: stage.required ? "failed" : "note",
            detail: missing(packs, stage, found.why),
          });
          continue;
        }
        const argv = found.argv;
        const got = yield* runTool(root, argv);
        ran = {
          output: [Bun.stripANSI(got.stdout), Bun.stripANSI(got.stderr)]
            .filter((text) => text.trim() !== "")
            .join("\n"),
          code: got.code,
        };
      }
      const log = join(dir, `${stage.name}.log`);
      yield* Effect.promise(() => writeFile(log, `$ ${shown}\n${ran.output}\n`));
      output.set(stage.name, ran.output);
      const passed = stage.okExit.includes(ran.code);
      results.push({
        stage,
        state: passed ? "passed" : "failed",
        detail: passed ? shown : `${shown} (exit ${ran.code})`,
        log,
      });
    }
    const failed = results.some((result) => result.state === "failed");
    return { output: formatGate(results, output, options.fast), code: failed ? 1 : 0 };
  });
