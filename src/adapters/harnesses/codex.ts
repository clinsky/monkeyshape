/**
 * Codex's adapter, its I/O: whether a session runs, a notice through `codex queue`, and which
 * sessions run in a directory. All of it reads Codex's own state under `CODEX_HOME`, which
 * Codex doesn't document (as Claude Code's sessions directory isn't): what this mshape
 * doesn't recognise is `unknown`, never a reason to prune.
 *
 * Tested on codex-cli 0.170.0: a running session holds an exclusive `flock` on
 * `thread-writer-locks/<id>.lock`; `codex queue` hands an idle session a user-role message
 * that starts a turn within seconds, a busy one after its turn, and keeps one for an ended
 * session until it is resumed, so a notice goes only to a session whose lock is held.
 */
import { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { standaloneNotice } from "../../core/notices.ts";
import type { HarnessIO, Registration, Sent, SessionStatus } from "../../harnesses/harness.ts";
import { runTool } from "../process.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** Codex's home: `CODEX_HOME`, else `~/.codex`. */
export const codexHome = (env: Env): string => env["CODEX_HOME"] || join(homedir(), ".codex");

const LOCKS = "thread-writer-locks";
const STATE_DB = "state_5.sqlite";

type Flock = (fd: number, operation: number) => number;

const LOCK_SH = 1;
const LOCK_NB = 4;
const LOCK_UN = 8;

const LIBC: Readonly<Record<string, ReadonlyArray<string>>> = {
  linux: ["libc.so.6", "libc.musl-x86_64.so.1", "libc.musl-aarch64.so.1"],
  darwin: ["libSystem.B.dylib"],
};

let flockFn: Flock | null | undefined;

/** libc's `flock`, or null where it can't be loaded (no FFI, an unknown libc). */
const loadFlock = async (): Promise<Flock | null> => {
  if (flockFn !== undefined) return flockFn;
  flockFn = null;
  try {
    const { dlopen, FFIType } = await import("bun:ffi");
    for (const name of LIBC[process.platform] ?? []) {
      try {
        const lib = dlopen(name, {
          flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
        });
        flockFn = lib.symbols.flock as Flock;
        break;
      } catch {
        // The next name.
      }
    }
  } catch {
    // No FFI here.
  }
  return flockFn;
};

/** Whether a lock file is held by another process: true, false, or undefined if unknowable. */
const held = async (path: string): Promise<boolean | undefined> => {
  const flock = await loadFlock();
  if (flock === null) return undefined;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return false;
  }
  try {
    if (flock(fd, LOCK_SH | LOCK_NB) !== 0) return true;
    flock(fd, LOCK_UN);
    return false;
  } finally {
    closeSync(fd);
  }
};

const statusOf = (home: string, session: string): Effect.Effect<SessionStatus> =>
  Effect.promise(async (): Promise<SessionStatus> => {
    const locks = join(home, LOCKS);
    if (!existsSync(locks))
      return {
        kind: "unknown",
        reason: `${locks} doesn't exist: this Codex keeps no session locks mshape knows`,
      };
    const lock = join(locks, `${session}.lock`);
    if (!existsSync(lock))
      return { kind: "gone", reason: `Codex session ${session} no longer runs` };
    const state = await held(lock);
    if (state === undefined)
      return {
        kind: "unknown",
        reason: "mshape can't test Codex's session locks here (no libc flock)",
      };
    return state
      ? { kind: "live" }
      : { kind: "gone", reason: `Codex session ${session} no longer runs` };
  });

/** The threads Codex records, with the directory each runs in; empty when unreadable. */
const threads = (home: string): ReadonlyArray<{ readonly id: string; readonly cwd: string }> => {
  const path = join(home, STATE_DB);
  if (!existsSync(path)) return [];
  try {
    const db = new Database(path, { readonly: true });
    try {
      return db.query("select id, cwd from threads where archived = 0").all() as Array<{
        id: string;
        cwd: string;
      }>;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
};

const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

/** Codex's I/O half, for the environment `env` (its `CODEX_HOME`, its PATH). */
export const codexIO = (env: Env): HarnessIO => {
  const home = codexHome(env);
  return {
    id: "codex",
    status: (registration: Registration) => statusOf(home, registration.session),
    notify: (registration: Registration, line: string) =>
      statusOf(home, registration.session).pipe(
        Effect.flatMap((status): Effect.Effect<Sent> => {
          if (status.kind === "gone" || status.kind === "unknown")
            return Effect.succeed({
              ok: false,
              gone: status.kind === "gone",
              reason: status.reason,
            });
          const codex = Bun.which("codex", { PATH: env["PATH"] ?? "" });
          if (codex === null)
            return Effect.succeed({ ok: false, gone: false, reason: "codex isn't on PATH" });
          return runTool(
            home,
            [codex, "queue", "--thread", registration.session, "--message", standaloneNotice(line)],
            undefined,
            env,
          ).pipe(
            Effect.map((ran): Sent => {
              if (ran.code === 0) return { ok: true };
              const reason =
                ran.stderr.trim().split("\n").at(-1) ?? `codex queue exited ${ran.code}`;
              return { ok: false, gone: false, reason: `codex queue failed: ${reason}` };
            }),
          );
        }),
      ),
    runningIn: (worktree: string) =>
      Effect.promise(async () => {
        const running: Array<string> = [];
        for (const thread of threads(home))
          if (inside(thread.cwd, worktree) && (await held(join(home, LOCKS, `${thread.id}.lock`))))
            running.push(thread.id);
        return running;
      }),
  };
};
