/**
 * Claude Code's I/O: its records of running sessions in its config directory
 * (`CLAUDE_CONFIG_DIR`, `~/.claude` by default), and its cross-session socket. Claude Code's
 * files come and go while it runs, so a file that can't be read is no record, never a failure.
 */
import { readdir, readFile, realpath } from "node:fs/promises";
import { connect } from "node:net";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import {
  type ClaudeKey,
  type ClaudeSession,
  claudeStatus,
  claudeTarget,
  decodeClaudeKey,
  decodeClaudeSession,
  sessionsIn,
  socketPayload,
} from "../../harnesses/claude-code/index.ts";
import type { HarnessIO, Registration, Sent } from "../../harnesses/harness.ts";

const text = (path: string) => Effect.promise(() => readFile(path, "utf8").catch(() => undefined));

const list = (path: string) => Effect.promise(() => readdir(path).catch(() => [] as Array<string>));

const real = (path: string) => Effect.promise(() => realpath(path).catch(() => path));

/** Whether a process exists. Signal 0 checks without sending anything. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists, and belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** A session that doesn't take the line in this long is skipped; its mail still waits. */
const SOCKET_TIMEOUT_MS = 2000;

/**
 * Claude Code's cross-session socket: newline-delimited JSON, an auth line then a user
 * message. The server never replies, so delivery is the write completing; a missing or
 * refusing socket means the session is gone.
 */
const send = (socket: string, token: string, line: string) =>
  Effect.callback<Sent>((resume) => {
    const connection = connect({ path: socket });
    connection.on("connect", () => {
      connection.end(socketPayload(token, line), () => resume(Effect.succeed({ ok: true })));
    });
    connection.on("error", (error: NodeJS.ErrnoException) =>
      resume(
        Effect.succeed({
          ok: false,
          gone: error.code === "ENOENT" || error.code === "ECONNREFUSED",
          reason: `its socket refused the notice (${error.code ?? error.message})`,
        }),
      ),
    );
    // Interrupted by the timeout: drop the connection.
    return Effect.sync(() => connection.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: SOCKET_TIMEOUT_MS,
      orElse: () =>
        Effect.succeed<Sent>({
          ok: false,
          gone: false,
          reason: "its socket didn't take the notice in time",
        }),
    }),
  );

export const claudeCodeIO = (env: Readonly<Record<string, string | undefined>>): HarnessIO => {
  const dir = `${env["CLAUDE_CONFIG_DIR"] || `${homedir()}/.claude`}/sessions`;

  const records = Effect.gen(function* () {
    const found: Array<ClaudeSession> = [];
    for (const file of yield* list(dir)) {
      if (!/^[0-9]+\.json$/.test(file)) continue;
      const raw = yield* text(`${dir}/${file}`);
      const record = raw === undefined ? undefined : decodeClaudeSession(raw);
      if (record !== undefined) found.push(record);
    }
    return found;
  });

  /** The record of the registration's process, by pid when it has one, else by session id. */
  const recordOf = (registration: Registration) =>
    Effect.gen(function* () {
      if (registration.pid === undefined)
        return (yield* records).find((record) => record.sessionId === registration.session);
      const raw = yield* text(`${dir}/${registration.pid}.json`);
      return raw === undefined ? undefined : decodeClaudeSession(raw);
    });

  const keysOf = (pid: number) =>
    Effect.gen(function* () {
      const keys: Array<ClaudeKey> = [];
      for (const file of yield* list(dir)) {
        if (!file.startsWith(`${pid}.`) || !file.endsWith(".key")) continue;
        const raw = yield* text(`${dir}/${file}`);
        const key = raw === undefined ? undefined : decodeClaudeKey(raw);
        if (key !== undefined) keys.push(key);
      }
      return keys;
    });

  return {
    id: "claude-code",
    status: (registration, now) =>
      Effect.map(recordOf(registration), (record) => claudeStatus(registration, record, now)),
    notify: (registration, line) =>
      Effect.gen(function* () {
        const record = yield* recordOf(registration);
        if (record === undefined || record.sessionId !== registration.session)
          return { ok: false, gone: false, reason: "Claude Code has no record of it yet" } as Sent;
        const target = claudeTarget(record, yield* keysOf(record.pid));
        if ("reason" in target) return { ok: false, gone: false, reason: target.reason } as Sent;
        return yield* send(target.socket, target.token, line);
      }),
    runningIn: (worktree) =>
      Effect.gen(function* () {
        const running: Array<ClaudeSession> = [];
        // Records of ended sessions linger: only a live process counts.
        for (const record of yield* records)
          if (record.cwd !== undefined && alive(record.pid))
            running.push({ ...record, cwd: yield* real(record.cwd) });
        return sessionsIn(worktree, running);
      }),
  };
};
