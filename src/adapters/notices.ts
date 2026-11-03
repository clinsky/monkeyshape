/**
 * `mshape msg register`, and the notices `msg send` pushes to a track's live sessions. The
 * registry lives under git's common directory (`sessions/<track>/<session>.json`); Claude
 * Code's own records live in its config directory (`sessions/<pid>.json` and the published
 * `<pid>.<hash>.key`), read here only to match a registration and fetch where and how to send.
 * Nothing in this file fails a send: the mail is already stored, so every problem becomes a
 * note. The decisions are in `src/core/notices.ts`.
 */

import { mkdir, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { Effect } from "effect";
import { sessionPath, trackSessionsDir } from "../core/layout.ts";
import type { Message } from "../core/mail.ts";
import {
  type ClaudeKey,
  type ClaudeSession,
  type Delivery,
  decodeClaudeKey,
  decodeClaudeSession,
  decodeRegistration,
  encodeRegistration,
  noticeLine,
  planNotice,
  type Registration,
  SESSION_ID,
  sessionStatus,
  socketPayload,
  type Target,
} from "../core/notices.ts";
import { fs, locate, trackCurrent } from "./tracks.ts";

/** A file's text, or undefined when it can't be read: Claude Code's files come and go. */
const text = (path: string) => Effect.promise(() => readFile(path, "utf8").catch(() => undefined));

const list = (path: string) => Effect.promise(() => readdir(path).catch(() => [] as Array<string>));

/** Claude Code's record of one process, and the key it published for senders. */
const claudeRecord = (claudeDir: string, pid: number) =>
  Effect.gen(function* () {
    const dir = `${claudeDir}/sessions`;
    const raw = yield* text(`${dir}/${pid}.json`);
    const session = raw === undefined ? undefined : decodeClaudeSession(raw);
    const keys: Array<ClaudeKey> = [];
    for (const file of yield* list(dir)) {
      if (!file.startsWith(`${pid}.`) || !file.endsWith(".key")) continue;
      const raw = yield* text(`${dir}/${file}`);
      const key = raw === undefined ? undefined : decodeClaudeKey(raw);
      if (key !== undefined) keys.push(key);
    }
    return { session, keys };
  });

/** Claude Code's session with this id, found by its own record. */
const claudeSession = (claudeDir: string, id: string) =>
  Effect.gen(function* () {
    const dir = `${claudeDir}/sessions`;
    for (const file of yield* list(dir)) {
      if (!/^[0-9]+\.json$/.test(file)) continue;
      const raw = yield* text(`${dir}/${file}`);
      const session = raw === undefined ? undefined : decodeClaudeSession(raw);
      if (session?.sessionId === id) return session;
    }
    return undefined as ClaudeSession | undefined;
  });

/**
 * Records this session against its track, so `send` can reach it. Outside a track it does
 * nothing (undefined); a problem is returned as a note, never a failure, since it runs as a
 * SessionStart hook. The pid comes from Claude Code's environment (`claudePid`) when it is
 * there, so the hook doesn't depend on Claude Code having written or updated its record
 * first; else from that record. `send` checks the session against the record anyway.
 */
export const register = (
  cwd: string,
  session: string,
  claudePid: number | undefined,
  claudeDir: string,
  now: Date,
) =>
  Effect.gen(function* () {
    if (!SESSION_ID.test(session))
      return `note: mshape msg register: \`${session}\` is not a Claude Code session id; this session gets no live notices`;
    const track = yield* trackCurrent(cwd).pipe(
      Effect.catchTag("TrackError", () => Effect.succeed(undefined)),
    );
    if (track === undefined) return undefined;
    const pid = claudePid ?? (yield* claudeSession(claudeDir, session))?.pid;
    if (pid === undefined)
      return `note: mshape msg register: Claude Code gave no CLAUDE_PID and has no record of session ${session} in ${claudeDir}/sessions; this session gets no live notices, only the unread subjects at each prompt`;
    const { common } = yield* locate(cwd);
    const registration: Registration = { session, pid, registered: now.toISOString() };
    const dir = trackSessionsDir(common, track);
    const path = sessionPath(common, track, session);
    const temporary = `${dir}/.${session}.${process.pid}.tmp`;
    yield* fs("create", dir, () => mkdir(dir, { recursive: true }));
    yield* fs("write", temporary, () => writeFile(temporary, encodeRegistration(registration)));
    yield* fs("write", path, () => rename(temporary, path));
    return undefined;
  }).pipe(
    Effect.catchTags({
      TrackError: (error) => Effect.succeed(`note: mshape msg register: ${error.reason}`),
      WorkspaceError: (error) => Effect.succeed(`note: mshape msg register: ${error.message}`),
    }),
  );

/** How one notice went: the session is gone (prune it), or it couldn't be told (say why). */
export type Sent =
  | { readonly ok: true }
  | { readonly ok: false; readonly gone: boolean; readonly reason: string };

/** How a notice reaches a session. Claude Code's socket is the one implementation now. */
export interface Notifier {
  readonly notify: (target: Target, line: string) => Effect.Effect<Sent>;
}

/** A session that doesn't take the line in this long is skipped; its mail still waits. */
const SOCKET_TIMEOUT_MS = 2000;

/**
 * Claude Code's cross-session socket: newline-delimited JSON, an auth line then a user
 * message. The server never replies, so delivery is the write completing; a missing or
 * refusing socket means the session is gone.
 */
export const claudeCodeNotifier: Notifier = {
  notify: (target, line) =>
    Effect.callback<Sent>((resume) => {
      const socket = connect({ path: target.socket });
      socket.on("connect", () => {
        socket.end(socketPayload(target.token, line), () => resume(Effect.succeed({ ok: true })));
      });
      socket.on("error", (error: NodeJS.ErrnoException) =>
        resume(
          Effect.succeed({
            ok: false,
            gone: error.code === "ENOENT" || error.code === "ECONNREFUSED",
            reason: `its socket refused the notice (${error.code ?? error.message})`,
          }),
        ),
      );
      // Interrupted by the timeout: drop the connection.
      return Effect.sync(() => socket.destroy());
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
    ),
};

/** Every registration file of a track, decoded; undefined for a file that isn't one. */
const registrations = (dir: string) =>
  Effect.gen(function* () {
    const found: Array<{ file: string; registration: Registration | undefined }> = [];
    for (const file of yield* list(dir)) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const raw = yield* text(`${dir}/${file}`);
      found.push({ file, registration: raw === undefined ? undefined : decodeRegistration(raw) });
    }
    return found;
  });

/**
 * The session ids of `track`'s registrations that are still running (live, or registered
 * just now ahead of Claude Code's record), by the same rule `send` uses; no socket is
 * touched. Registrations whose session is gone, and files that aren't registrations, are
 * removed on the way. For `track rm`, which refuses while a session runs in the worktree.
 */
export const liveSessions = (cwd: string, track: string, claudeDir: string, now: Date) =>
  Effect.gen(function* () {
    const { common } = yield* locate(cwd);
    const dir = trackSessionsDir(common, track);
    const live: Array<string> = [];
    for (const { file, registration } of yield* registrations(dir)) {
      const { session } =
        registration === undefined
          ? { session: undefined }
          : yield* claudeRecord(claudeDir, registration.pid);
      if (registration !== undefined && sessionStatus(registration, session, now).kind !== "gone")
        live.push(registration.session);
      else yield* Effect.promise(() => unlink(`${dir}/${file}`).catch(() => undefined));
    }
    return live.sort();
  });

/** Deletes `track`'s session registry; how many registrations it held. For `track rm`. */
export const removeSessions = (cwd: string, track: string) =>
  Effect.gen(function* () {
    const { common } = yield* locate(cwd);
    const dir = trackSessionsDir(common, track);
    const count = (yield* registrations(dir)).length;
    yield* fs("remove", dir, () => rm(dir, { recursive: true, force: true }));
    return count;
  });

/**
 * Tells every live session registered for `track`, and prunes registrations whose session is
 * gone. Never fails: whatever goes wrong is in the returned delivery's notes.
 */
export const notifyTrack = (
  common: string,
  track: string,
  line: string,
  notifier: Notifier,
  claudeDir: string,
  now: Date,
) =>
  Effect.gen(function* () {
    const dir = trackSessionsDir(common, track);
    let notified = 0;
    const pruned: Array<string> = [];
    const skipped: Array<string> = [];
    const prune = (file: string, reason: string) =>
      Effect.map(
        Effect.promise(() => unlink(`${dir}/${file}`).catch(() => undefined)),
        () => {
          pruned.push(reason);
        },
      );
    for (const { file, registration } of yield* registrations(dir)) {
      if (registration === undefined) {
        yield* prune(file, `${file} is not a registration`);
        continue;
      }
      const { session, keys } = yield* claudeRecord(claudeDir, registration.pid);
      const plan = planNotice(registration, session, keys, now);
      if (plan.kind === "prune")
        yield* prune(file, `session ${registration.session}: ${plan.reason}`);
      else if (plan.kind === "skip")
        skipped.push(`session ${registration.session}: ${plan.reason}`);
      else {
        const sent = yield* notifier.notify(plan.target, line);
        if (sent.ok) notified++;
        else if (sent.gone) yield* prune(file, `session ${registration.session}: ${sent.reason}`);
        else skipped.push(`session ${registration.session}: ${sent.reason}`);
      }
    }
    return { notified, pruned, skipped } satisfies Delivery;
  });

/** After `send` stored `message`: a notice to each live session of its recipient. */
export const notifyRecipient = (
  cwd: string,
  message: Message,
  notifier: Notifier,
  claudeDir: string,
  now: Date,
) =>
  Effect.flatMap(locate(cwd), ({ common }) =>
    notifyTrack(common, message.to, noticeLine(message), notifier, claudeDir, now),
  );
