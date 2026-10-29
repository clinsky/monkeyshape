/** Running a command: the one spawn helper every adapter uses. */
import { Effect } from "effect";
import { WorkspaceError } from "../schemas/errors.ts";

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `command` in `cwd` to completion. A command that can't start fails with the reason. */
export const run = (cwd: string, command: ReadonlyArray<string>) =>
  Effect.try({
    try: () => Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" }),
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
export const runTool = (cwd: string, command: ReadonlyArray<string>) =>
  run(cwd, command).pipe(
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.succeed<Ran>({ code: -1, stdout: "", stderr: error.reason }),
    ),
  );
