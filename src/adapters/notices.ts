/**
 * Session addresses: `mshape msg register`, where a session's mail goes, the move `mshape
 * review` makes, and the notices `msg send` pushes to an address's live sessions. The
 * registry lives under git's common directory (`sessions/<address>/<session>.json`); Claude
 * Code's own records live in its config directory (`sessions/<pid>.json` and the published
 * `<pid>.<hash>.key`), read here only to match a registration and fetch where and how to send.
 * Nothing here fails a send: the mail is already stored, so every problem becomes a note.
 * Only `send` prunes the registry, and `review` and `register` move or replace a session's
 * own registration; reads never change it. The decisions are in `src/core/notices.ts`.
 */

import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { connect } from "node:net";
import { Effect } from "effect";
import { mshapeCommand } from "../core/hooks.ts";
import {
  reviewOf,
  reviewPath,
  sessionPath,
  sessionsDir,
  TRACK_NAME,
  trackSessionsDir,
  worktreePath,
} from "../core/layout.ts";
import { directoryAddress, type Message } from "../core/mail.ts";
import {
  alsoRegistered,
  ambiguousSelf,
  type ClaudeKey,
  type ClaudeSession,
  type Delivery,
  decodeClaudeKey,
  decodeClaudeSession,
  decodeRegistration,
  encodeRegistration,
  findSelf,
  type Identity,
  NO_IDENTITY,
  noticeLine,
  type Placed,
  planNotice,
  type Registration,
  reviewMove,
  SESSION_ID,
  type Self,
  sessionStatus,
  sessionsIn,
  socketPayload,
  type Target,
} from "../core/notices.ts";
import { fs, gitOk, locate, refuse, trackCurrent, trackNames, worktrees } from "./tracks.ts";

/** Symlinks resolved; a path that doesn't exist stays as it is. */
const real = (path: string) => Effect.promise(() => realpath(path).catch(() => path));

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

/** Who runs a command, and how to tell whether a registration's session still runs. */
export interface Caller {
  readonly identity: Identity;
  readonly claudeDir: string;
  readonly now: Date;
}

/** The address of the checkout `cwd` is in, or why it has none. */
export const directoryAddressOf = (cwd: string) =>
  Effect.gen(function* () {
    const { repo } = yield* locate(cwd);
    const registered = yield* worktrees(repo);
    const here = yield* real(yield* gitOk(cwd, ["rev-parse", "--show-toplevel"]));
    // git's path for this checkout, in the layout's terms (worktrees() resolved them alike).
    let toplevel = here;
    for (const worktree of registered)
      if ((yield* real(worktree.path)) === here) toplevel = worktree.path;
    const track = yield* trackCurrent(cwd, { onTrackBranch: false }).pipe(
      Effect.map((name) => ({ track: name })),
      Effect.catchTag("TrackError", (error) => Effect.succeed({ reason: error.reason })),
    );
    return directoryAddress(repo, toplevel, registered, track);
  });

/** Every registration at every address, decoded; files that aren't one are left alone. */
const allPlaced = (common: string) =>
  Effect.gen(function* () {
    const placed: Array<Placed> = [];
    for (const address of yield* list(sessionsDir(common))) {
      if (!TRACK_NAME.test(address)) continue;
      for (const { registration } of yield* registrations(trackSessionsDir(common, address)))
        if (registration !== undefined) placed.push({ address, registration });
    }
    return placed;
  });

/** Whether a registration's session still runs, by the rule `send` and `track rm` use. */
const runningNow = (caller: Caller, registration: Registration) =>
  Effect.map(
    claudeRecord(caller.claudeDir, registration.pid),
    ({ session }) => sessionStatus(registration, session, caller.now).kind !== "gone",
  );

/** The caller's own registration, found by `findSelf` over the whole registry. */
const selfIn = (placed: ReadonlyArray<Placed>, caller: Caller) =>
  Effect.gen(function* () {
    const running = new Set<Placed>();
    if (caller.identity.session === undefined && caller.identity.pid !== undefined)
      for (const entry of placed)
        if (
          entry.registration.pid === caller.identity.pid &&
          (yield* runningNow(caller, entry.registration))
        )
          running.add(entry);
    return findSelf(placed, caller.identity, (entry) => running.has(entry));
  });

/** Writes a registration under `address` by atomic rename, so a reader never sees half one. */
const writeRegistration = (common: string, address: string, registration: Registration) =>
  Effect.gen(function* () {
    const dir = trackSessionsDir(common, address);
    const path = sessionPath(common, address, registration.session);
    const temporary = `${dir}/.${registration.session}.${process.pid}.tmp`;
    yield* fs("create", dir, () => mkdir(dir, { recursive: true }));
    yield* fs("write", temporary, () => writeFile(temporary, encodeRegistration(registration)));
    yield* fs("write", path, () => rename(temporary, path));
  });

const removeRegistration = (common: string, placed: Placed) => {
  const path = sessionPath(common, placed.address, placed.registration.session);
  return Effect.promise(() => unlink(path).catch(() => undefined));
};

/**
 * Where the caller's mail is: its registration's address, or else its checkout's.
 * `unregistered` is set for a caller Claude Code identified that has no registration, for the
 * inbox hook to say so, with whether `register` could find its pid. Fails only when neither
 * address exists, with the directory's reason.
 */
export const sessionAddress = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const directory = yield* directoryAddressOf(cwd);
    const { common } = yield* locate(cwd);
    const self = yield* selfIn(yield* allPlaced(common), caller);
    if (self.kind === "registered") return { address: self.placed.address };
    if ("reason" in directory) return yield* refuse(directory.reason);
    const { session } = caller.identity;
    if (self.kind !== "unregistered" || session === undefined)
      return { address: directory.address };
    const registrable =
      caller.identity.pid !== undefined ||
      (yield* claudeSession(caller.claudeDir, session)) !== undefined;
    return { address: directory.address, unregistered: { session, registrable } };
  });

/**
 * Records this session at its address, so `send` can reach it: where it is already
 * registered (a compaction or a resume keeps the session id, and with it a review's address),
 * else its checkout's. Outside every address it does nothing (undefined); a problem is
 * returned as a note, never a failure, since it runs as a SessionStart hook. The pid comes
 * from Claude Code's environment when it is there, so the hook doesn't depend on Claude Code
 * having written or updated its record first; else from that record.
 */
export const register = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const { session } = caller.identity;
    if (session === undefined) return `note: mshape msg register: ${NO_IDENTITY}`;
    if (!SESSION_ID.test(session))
      return `note: mshape msg register: \`${session}\` is not a Claude Code session id; this session gets no live notices`;
    // Outside a repo, as outside every address: nothing to register, and nothing to say.
    const directory = yield* directoryAddressOf(cwd).pipe(
      Effect.catchTag("TrackError", (error) => Effect.succeed({ reason: error.reason })),
    );
    if ("reason" in directory) return undefined;
    const pid = caller.identity.pid ?? (yield* claudeSession(caller.claudeDir, session))?.pid;
    if (pid === undefined)
      return `note: mshape msg register: Claude Code gave no CLAUDE_PID and has no record of session ${session} in ${caller.claudeDir}/sessions; this session gets no live notices, only the unread subjects at each prompt`;
    const { common } = yield* locate(cwd);
    const placed = yield* allPlaced(common);
    const self = yield* selfIn(placed, caller);
    // A review whose worktree went without `review rm` is no address any more: start over here.
    const { repo } = yield* locate(cwd);
    const pr = self.kind === "registered" ? reviewOf(self.placed.address) : undefined;
    const reviewGone =
      pr !== undefined &&
      !(yield* worktrees(repo)).some((worktree) => worktree.path === reviewPath(repo, pr));
    const address =
      self.kind === "registered" && !reviewGone ? self.placed.address : directory.address;
    yield* writeRegistration(common, address, {
      session,
      pid,
      registered: caller.now.toISOString(),
    });
    // A move cut short left a copy elsewhere: this session is where it was just written.
    for (const entry of placed)
      if (entry.registration.session === session && entry.address !== address)
        yield* removeRegistration(common, entry);
    const others: Array<string> = [];
    for (const entry of placed)
      if (
        entry.address === address &&
        entry.registration.session !== session &&
        entry.registration.pid !== pid &&
        (yield* runningNow(caller, entry.registration))
      )
        others.push(entry.registration.session);
    return others.length === 0 ? undefined : alsoRegistered(address, others);
  }).pipe(
    Effect.catchTags({
      TrackError: (error) => Effect.succeed(`note: mshape msg register: ${error.reason}`),
      WorkspaceError: (error) => Effect.succeed(`note: mshape msg register: ${error.message}`),
    }),
  );

/**
 * Moves the caller's registration from `from` to `to`, as `review <pr>` and `track enter` do:
 * a write at `to`, then the delete. A caller identified but never registered starts at `to`.
 * Mail is never moved: what is unread at `from` stays there. Returns what it did.
 */
const moveSession = (common: string, caller: Caller, self: Self, from: string, to: string) =>
  Effect.gen(function* () {
    if (self.kind === "registered") {
      // Stamped now, so a copy a cut-short move leaves behind is the older one.
      yield* writeRegistration(common, to, {
        ...self.placed.registration,
        registered: caller.now.toISOString(),
      });
      yield* removeRegistration(common, self.placed);
      return [`session ${self.placed.registration.session}: ${from} -> ${to}`];
    }
    const { session } = caller.identity;
    const pid =
      caller.identity.pid ??
      (session === undefined ? undefined : (yield* claudeSession(caller.claudeDir, session))?.pid);
    if (session === undefined || pid === undefined)
      return [
        `note: no session moved to ${to}: this session isn't registered, and Claude Code gave ${session === undefined ? "no session id" : "no CLAUDE_PID"} to register it with`,
      ];
    yield* writeRegistration(common, to, { session, pid, registered: caller.now.toISOString() });
    return [`session ${session}: ${from} -> ${to} (it wasn't registered; now it is)`];
  });

/**
 * The move `mshape review <pr>` makes, worked out before the review's worktree is touched,
 * so an ambiguous caller is refused before anything happens. `apply` moves the session (a
 * write at the new address, then the delete) and says what it did.
 */
export const planReviewMove = (cwd: string, caller: Caller, pr: string) =>
  Effect.gen(function* () {
    const { common } = yield* locate(cwd);
    const directory = yield* directoryAddressOf(cwd);
    const self: Self = yield* selfIn(yield* allPlaced(common), caller);
    if (self.kind === "ambiguous") return yield* refuse(ambiguousSelf(self.placed));
    const from =
      self.kind === "registered"
        ? self.placed.address
        : "address" in directory
          ? directory.address
          : undefined;
    const to = from === undefined ? undefined : reviewMove(from, pr);
    const none = Effect.succeed([] as ReadonlyArray<string>);
    if (to === undefined || from === undefined) return { apply: none };
    if (self.kind === "anonymous")
      return { apply: Effect.succeed([`note: no session moved to ${to}: ${NO_IDENTITY}`]) };
    return { apply: moveSession(common, caller, self, from, to) };
  });

/**
 * `mshape track enter <track>`: moves the calling session's registration to `track`, so its
 * mail and notices are the track's, and returns what it did and, last, the track's worktree,
 * where the session then works. Unread mail stays where it was. A restart with a new session
 * id registers by its directory again (`register`), until this runs again.
 */
export const enterTrack = (cwd: string, caller: Caller, track: string) =>
  Effect.gen(function* () {
    const { common, repo } = yield* locate(cwd);
    const tracks = yield* trackNames(repo);
    if (!tracks.includes(track))
      return yield* refuse(
        `no track \`${track}\`: ${tracks.length === 0 ? "there are none" : `the tracks are ${tracks.join(", ")}`}. Start it with \`${mshapeCommand(["track", "new", track])}\``,
      );
    const self = yield* selfIn(yield* allPlaced(common), caller);
    if (self.kind === "anonymous") return yield* refuse(`nothing to move: ${NO_IDENTITY}`);
    if (self.kind === "ambiguous") return yield* refuse(ambiguousSelf(self.placed));
    const path = worktreePath(repo, track);
    if (self.kind === "registered" && self.placed.address === track)
      return [`session ${self.placed.registration.session} is at ${track} already`, path];
    const directory = yield* directoryAddressOf(cwd).pipe(
      Effect.catchTag("TrackError", () => Effect.succeed({ reason: "" })),
    );
    const from =
      self.kind === "registered"
        ? self.placed.address
        : "address" in directory
          ? directory.address
          : "nowhere";
    const moved = yield* moveSession(common, caller, self, from, track);
    if (moved[0]?.startsWith("note:")) return yield* refuse(moved[0].slice("note: ".length));
    return [...moved, path];
  });

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

/** Only an address reaches the registry: an empty or odd one would address all of it. */
const validTrack = (track: string) =>
  TRACK_NAME.test(track)
    ? Effect.void
    : refuse(`\`${track}\` is not an address, so its session registry can't be read`);

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

/** Claude Code's records of live processes, `cwd` resolved, for matching against a worktree. */
const runningRecords = (claudeDir: string) =>
  Effect.gen(function* () {
    const dir = `${claudeDir}/sessions`;
    const records: Array<ClaudeSession> = [];
    for (const file of yield* list(dir)) {
      if (!/^[0-9]+\.json$/.test(file)) continue;
      const raw = yield* text(`${dir}/${file}`);
      const record = raw === undefined ? undefined : decodeClaudeSession(raw);
      // Records of ended sessions linger: only a live process counts.
      if (record?.cwd === undefined || !alive(record.pid)) continue;
      records.push({ ...record, cwd: yield* real(record.cwd) });
    }
    return records;
  });

/**
 * The ids of Claude Code sessions running in `track`, for `track rm`, which refuses while one
 * would lose its worktree. Two sources: the track's registrations that are still running
 * (live, or registered just now ahead of Claude Code's record), by the same rule `send` uses;
 * and any live session whose directory is inside the track's worktree, registered or not. No
 * socket is touched, and nothing is removed: only `send` prunes.
 */
export const liveSessions = (cwd: string, track: string, claudeDir: string, now: Date) =>
  Effect.gen(function* () {
    yield* validTrack(track);
    const { common, repo } = yield* locate(cwd);
    const dir = trackSessionsDir(common, track);
    const live = new Set<string>();
    for (const { registration } of yield* registrations(dir)) {
      const { session } =
        registration === undefined
          ? { session: undefined }
          : yield* claudeRecord(claudeDir, registration.pid);
      if (registration !== undefined && sessionStatus(registration, session, now).kind !== "gone")
        live.add(registration.session);
    }
    const worktree = yield* real(worktreePath(repo, track));
    for (const id of sessionsIn(worktree, yield* runningRecords(claudeDir))) live.add(id);
    return [...live].sort();
  });

/** Deletes an address's session registry; how many registrations it held. For `track rm` and `review rm`. */
export const removeSessions = (cwd: string, track: string) =>
  Effect.gen(function* () {
    yield* validTrack(track);
    const { common } = yield* locate(cwd);
    const dir = trackSessionsDir(common, track);
    const held = (yield* registrations(dir)).filter((entry) => entry.registration !== undefined);
    yield* fs("remove", dir, () => rm(dir, { recursive: true, force: true }));
    return held.length;
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
