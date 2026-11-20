/** Running a command: the one spawn helper every adapter uses. */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import { WorkspaceError } from "../schemas/errors.ts";
import { runningCompiled } from "./launch.ts";

/** Where a compiled `mshape` looks for Bun after the PATH: where Bun's installer puts it. */
const BUN_HOME = "~/.bun/bin/bun";

/** Why a command that needs Bun can't run: no Bun in either place `bunPath` looks. */
export const BUN_NOT_FOUND = `bun is not on PATH or at ${BUN_HOME}`;
/** What to do about it, as a sentence. */
export const BUN_FIX = "Install Bun (https://bun.sh): this TypeScript repo's tools run on it.";
/** Both, for a message that has room for one clause. */
export const BUN_MISSING = `${BUN_NOT_FOUND}: install Bun (https://bun.sh), which this TypeScript repo's tools run on`;

/**
 * The Bun to spawn for a package's tool, `bun install` or `bun run`. Under Bun (a checkout,
 * an npm install) it is the one running `mshape`, so it exists. The compiled `mshape` is its
 * own `process.execPath`, and spawning that would run `mshape` again: it uses `bun` from the
 * PATH, then Bun's own install, and undefined when neither is there.
 */
export const bunPath = (): string | undefined => {
  if (!runningCompiled()) return process.execPath;
  const onPath = Bun.which("bun");
  if (onPath !== null) return onPath;
  const installed = BUN_HOME.replace("~", homedir());
  return existsSync(installed) ? installed : undefined;
};

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `command` in `cwd` to completion, with `stdin` as its input when given, in `env` when
 * given (this process's otherwise). A command that can't start fails with the reason.
 */
export const run = (
  cwd: string,
  command: ReadonlyArray<string>,
  stdin?: string,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.try({
    try: () =>
      Bun.spawn([...command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
        ...(env === undefined ? {} : { env: { ...env } }),
      }),
    catch: (cause) =>
      new WorkspaceError({ operation: "run", path: command.join(" "), reason: String(cause) }),
  }).pipe(
    Effect.flatMap((child) =>
      // Both pipes at once: a tool that fills one while we wait on the other would hang.
      Effect.all(
        [
          Effect.promise(() => new Response(child.stdout).text()),
          Effect.promise(() => new Response(child.stderr).text()),
          Effect.promise(() => child.exited),
        ],
        { concurrency: "unbounded" },
      ),
    ),
    Effect.map(([stdout, stderr, code]): Ran => ({ code, stdout, stderr })),
  );

/** For optional tools: a spawn failure is exit code -1 with the reason on stderr, not an abort. */
export const runTool = (
  cwd: string,
  command: ReadonlyArray<string>,
  stdin?: string,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  run(cwd, command, stdin, env).pipe(
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.succeed<Ran>({ code: -1, stdout: "", stderr: error.reason }),
    ),
  );
