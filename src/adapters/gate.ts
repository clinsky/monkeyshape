/**
 * Runs `mshape gate`: each stage `gateStages` plans, one after another, a failure never
 * stopping the ones after it. Each run stage's whole output is kept in a log under the git
 * directory, so a failure shows its tail and points at the rest.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import {
  CHECK_STAGE,
  formatGate,
  gateStages,
  type PlannedStage,
  type StageResult,
  stageCommand,
} from "../core/gate.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import { runTool } from "./process.ts";
import { localBin } from "./workspace.ts";

/**
 * Where a stage's output is kept: the worktree's own git dir, so tracks never share one; outside
 * git, a temp directory named for the root, so two repos never share one either.
 */
const logDir = (root: string) =>
  Effect.map(runTool(root, ["git", "rev-parse", "--absolute-git-dir"]), (got) =>
    got.code === 0
      ? join(got.stdout.trim(), "monkeyshape", "gate")
      : join(tmpdir(), `mshape-gate-${Bun.hash(resolve(root)).toString(16)}`),
  );

/**
 * A stage's argv as it can be spawned, or undefined when its program isn't here. `bun` is this
 * bun. A tool in node_modules/.bin (the worktree's, else the main checkout's) runs through this
 * bun too, since its shim starts with `#!/usr/bin/env node`. Anything else, from the PATH.
 */
const command = (root: string, run: ReadonlyArray<string>, path: string | undefined) =>
  Effect.gen(function* () {
    const [program, ...rest] = run;
    if (program === undefined) return undefined;
    if (program === "bun") return [process.execPath, ...rest];
    // A path, such as `./scripts/check.sh`: there or not, from the repo root.
    if (program.includes("/"))
      return (yield* Effect.promise(() => Bun.file(resolve(root, program)).exists()))
        ? [...run]
        : undefined;
    const bin = yield* localBin(root, program);
    if (bin !== undefined) return [...bin, ...rest];
    return Bun.which(program, path === undefined ? {} : { PATH: path }) === null
      ? undefined
      : [...run];
  });

const missing = (stage: PlannedStage): string => {
  const program = stage.run[0] ?? "";
  if (stage.origin === "repo" || stage.replaced)
    return `\`${program}\` isn't installed here (not in node_modules/.bin or on the PATH), and this repo's gate stage \`${stage.name}\` needs it: install it, or change the stage in [gate].stages`;
  return stage.required
    ? `\`${program}\` isn't installed here (not in node_modules/.bin or on the PATH): the ${stage.origin} pack requires it. Install it (\`bun install\` for a TypeScript repo's tools)`
    : `\`${program}\` isn't installed, and \`prerequisites\` makes it optional: \`${stage.name}\` didn't run`;
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
  },
) =>
  Effect.gen(function* () {
    const dir = yield* logDir(root);
    yield* Effect.promise(() => mkdir(dir, { recursive: true }));
    const results: Array<StageResult> = [];
    const output = new Map<string, string>();
    for (const stage of gateStages(config)) {
      const shown = stageCommand(stage);
      if (options.fast && !stage.fast) {
        results.push({ stage, state: "skipped", detail: `${shown} (--fast runs the fast phase)` });
        continue;
      }
      let ran: GateRun;
      if (stage.name === CHECK_STAGE)
        ran = yield* options.check.pipe(
          Effect.catch((error) =>
            Effect.succeed({ output: `mshape check couldn't run: ${String(error)}`, code: 1 }),
          ),
        );
      else {
        const argv = yield* command(root, stage.run, options.path);
        if (argv === undefined) {
          results.push({
            stage,
            state: stage.required ? "failed" : "note",
            detail: missing(stage),
          });
          continue;
        }
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
