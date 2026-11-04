/**
 * Session addresses and live notices. A session registers itself at start (`mshape msg
 * register`, from its SessionStart hook) at the address of the checkout it runs in: a track,
 * `main` or `review-<n>`. From then on its address is its registration, never its directory:
 * a session at `main` that runs `mshape review <n>` moves to `review-<n>`, and its mail and
 * notices follow. A session outside every address never registers, so other work on the
 * machine never gets a notice. At send time each registration is matched against Claude Code's own record of the
 * session (`~/.claude/sessions/<pid>.json`, undocumented, so read strictly and by protocol
 * version), and the socket and token come from there, never from the mailbox.
 * `src/adapters/notices.ts` does the I/O. Claude Code's socket never replies, so a session is
 * live when its record matches and its socket accepts the connection; nothing more is known.
 */
import { mshapeCommand } from "./hooks.ts";
import { MAIN_ADDRESS, reviewAddress, reviewOf } from "./layout.ts";
import { addressLabel, type Message } from "./mail.ts";

/**
 * One live session at an address, as `register` records it under the session registry. Only
 * what the session knows of itself when its SessionStart hook runs: nothing here depends on
 * Claude Code having written its own record yet. Everything else is read at send time.
 */
export interface Registration {
  /** A UUID per session: a reused pid or a `/clear` runs a different one. */
  readonly session: string;
  /** Claude Code's process: its session file is `<pid>.json`. */
  readonly pid: number;
  readonly registered: string;
}

/** The fields of Claude Code's session file that a notice depends on. */
export interface ClaudeSession {
  readonly pid: number;
  /** The directory the session runs in, when the record says; `track rm` reads it. */
  readonly cwd?: string;
  readonly sessionId: string;
  readonly procStart: string;
  readonly peerProtocol: number;
  readonly messagingSocketPath: string;
}

/**
 * The fields of a published key file (`<pid>.<hash>.key`) a sender uses. Keys of earlier
 * processes with the same pid can linger, so `procStart` says which process published it.
 */
export interface ClaudeKey {
  readonly peerToken: string;
  readonly procStart: string;
}

/** The one socket protocol notices are written for (Claude Code 2.1.317). */
export const PEER_PROTOCOL = 1;

/** A session id as Claude Code writes it: also a file name in the registry, so nothing else. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const object = (text: string): Record<string, unknown> | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

export const decodeRegistration = (text: string): Registration | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { session, pid, registered } = value;
  return typeof session === "string" &&
    SESSION_ID.test(session) &&
    typeof pid === "number" &&
    typeof registered === "string"
    ? { session, pid, registered }
    : undefined;
};

export const encodeRegistration = (registration: Registration): string =>
  `${JSON.stringify(registration, null, 2)}\n`;

/** Claude Code's session file, or undefined when it lacks a field a notice needs. */
export const decodeClaudeSession = (text: string): ClaudeSession | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { pid, cwd, sessionId, procStart, peerProtocol, messagingSocketPath } = value;
  return typeof pid === "number" &&
    typeof sessionId === "string" &&
    typeof procStart === "string" &&
    typeof peerProtocol === "number" &&
    typeof messagingSocketPath === "string"
    ? {
        pid,
        ...(typeof cwd === "string" ? { cwd } : {}),
        sessionId,
        procStart,
        peerProtocol,
        messagingSocketPath,
      }
    : undefined;
};

export const decodeClaudeKey = (text: string): ClaudeKey | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { peerToken, procStart } = value;
  return typeof peerToken === "string" && typeof procStart === "string"
    ? { peerToken, procStart }
    : undefined;
};

/** Where to send a notice, read at send time and never stored. */
export interface Target {
  readonly session: string;
  readonly socket: string;
  readonly token: string;
}

/**
 * What to do with one registration, from Claude Code's current record of its process:
 * notify it, prune it (the session is gone or is now another one), or skip it with a reason
 * (it is live, but this version of mshape can't talk to it).
 */
export type Plan =
  | { readonly kind: "notify"; readonly target: Target }
  | { readonly kind: "prune"; readonly reason: string }
  | { readonly kind: "skip"; readonly reason: string };

/**
 * How long a new registration may run ahead of Claude Code's record. The hook can register
 * before Claude Code writes its record (at start) or updates it (after /clear); a send in that
 * window must not prune a registration that is about to be right.
 */
export const REGISTRATION_GRACE_MS = 30_000;

/**
 * Whether a registration's session is still running, from Claude Code's current record of
 * its process: `live`, `pending` (it registered just now, ahead of the record, so it counts
 * as running), or `gone` with the reason. The one rule `send` and `track rm` both use.
 */
export type SessionStatus =
  | { readonly kind: "live" | "pending" }
  | { readonly kind: "gone"; readonly reason: string };

export const sessionStatus = (
  registration: Registration,
  session: ClaudeSession | undefined,
  now: Date,
): SessionStatus => {
  // A /clear starts a new session id in the same process; a reused pid runs another one.
  if (session !== undefined && session.sessionId === registration.session) return { kind: "live" };
  const age = now.getTime() - Date.parse(registration.registered);
  if (age >= 0 && age < REGISTRATION_GRACE_MS) return { kind: "pending" };
  return {
    kind: "gone",
    reason:
      session === undefined
        ? "its Claude Code session has ended"
        : "its process now runs another session",
  };
};

/**
 * Sessions running inside a worktree whether or not they registered (one started before the
 * register hook existed, or whose `register` only gave a note): by the record's `cwd`.
 * Paths are compared as given, so the caller resolves symlinks on both sides first.
 */
export const sessionsIn = (
  worktree: string,
  records: ReadonlyArray<ClaudeSession>,
): ReadonlyArray<string> =>
  records
    .filter((record) => record.cwd === worktree || record.cwd?.startsWith(`${worktree}/`))
    .map((record) => record.sessionId);

export const planNotice = (
  registration: Registration,
  session: ClaudeSession | undefined,
  keys: ReadonlyArray<ClaudeKey>,
  now: Date,
): Plan => {
  const status = sessionStatus(registration, session, now);
  if (status.kind === "gone") return { kind: "prune", reason: status.reason };
  if (status.kind === "pending" || session === undefined)
    return { kind: "skip", reason: "it registered just now, before Claude Code recorded it; kept" };
  if (session.peerProtocol !== PEER_PROTOCOL)
    return {
      kind: "skip",
      reason: `Claude Code speaks messaging protocol ${session.peerProtocol}; this mshape knows ${PEER_PROTOCOL}`,
    };
  // The live process's key, whatever order the directory lists leftovers in.
  const key = keys.find((candidate) => candidate.procStart === session.procStart);
  if (key === undefined) return { kind: "skip", reason: "Claude Code published no key for it" };
  return {
    kind: "notify",
    target: {
      session: registration.session,
      socket: session.messagingSocketPath,
      token: key.peerToken,
    },
  };
};

/** What Claude Code tells a command about the session running it; either may be missing. */
export interface Identity {
  readonly session?: string;
  readonly pid?: number;
}

/** A registration, and the address it is filed under. */
export interface Placed {
  readonly address: string;
  readonly registration: Registration;
}

/**
 * Which registration is the caller's own. By session id when Claude Code gave one: a session
 * filed twice (a move cut short between its write and its delete) is where it was filed last.
 * By pid alone only among registrations still running, and more than one is ambiguous (a
 * `/clear` just now: the process's old session and its new one). Without either, nobody:
 * the caller is never guessed from a directory or from who else is registered.
 */
export type Self =
  | { readonly kind: "anonymous" }
  | { readonly kind: "unregistered" }
  | { readonly kind: "registered"; readonly placed: Placed }
  | { readonly kind: "ambiguous"; readonly placed: ReadonlyArray<Placed> };

export const findSelf = (
  placed: ReadonlyArray<Placed>,
  identity: Identity,
  running: (entry: Placed) => boolean,
): Self => {
  const newest = (a: Placed, b: Placed) =>
    b.registration.registered.localeCompare(a.registration.registered);
  if (identity.session !== undefined) {
    const [mine] = placed
      .filter((entry) => entry.registration.session === identity.session)
      .sort(newest);
    return mine === undefined ? { kind: "unregistered" } : { kind: "registered", placed: mine };
  }
  if (identity.pid === undefined) return { kind: "anonymous" };
  const mine = placed.filter((entry) => entry.registration.pid === identity.pid && running(entry));
  if (mine.length > 1) return { kind: "ambiguous", placed: mine };
  return mine[0] === undefined ? { kind: "unregistered" } : { kind: "registered", placed: mine[0] };
};

/**
 * Where `mshape review <pr>` puts a session at `from`: a session at `main` or at another
 * review moves to `review-<pr>`; one at a track stays, since its track's mail is its work.
 * Undefined is no move.
 */
export const reviewMove = (from: string, pr: string): string | undefined =>
  (from === MAIN_ADDRESS || reviewOf(from) !== undefined) && from !== reviewAddress(pr)
    ? reviewAddress(pr)
    : undefined;

export const NO_IDENTITY =
  "no session identity: Claude Code gave no session id (hook input or CLAUDE_CODE_SESSION_ID) and no CLAUDE_PID, so this has no address of its own and none is guessed";

export const ambiguousSelf = (placed: ReadonlyArray<Placed>): string =>
  `which session runs this is ambiguous: process ${placed[0]?.registration.pid} has ${placed.length} running registrations (${placed.map((entry) => `session ${entry.registration.session} at ${entry.address}`).join(", ")}). Run it again from the session itself, where Claude Code sets CLAUDE_CODE_SESSION_ID`;

/** What the inbox hook adds for a session that has an id but no registration. */
export const unregisteredNote = (session: string, address: string): string =>
  `note: this session (${session}) isn't registered, so it gets no live notices, and its mail is taken from its directory's address, ${addressLabel(address)}. Run \`${mshapeCommand(["msg", "register"])}\` to register it.`;

/** What `register` says when other running sessions share the address. */
export const alsoRegistered = (address: string, others: ReadonlyArray<string>): string =>
  `note: ${others.map((id) => `session ${id}`).join(", ")} ${others.length === 1 ? "is" : "are"} also registered at ${address}: each gets its notices, and a message one of you reads is read for all`;

/** One line, never the body: the recipient decides when to read it. */
export const noticeLine = (message: Message): string =>
  `[mshape] Message from ${message.from}: ${message.subject} (${mshapeCommand(["msg", "read", message.id])})`;

/** The two lines Claude Code's socket reads: auth, then the notice as a user message. */
export const socketPayload = (token: string, line: string): string =>
  `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({
    type: "user",
    message: { role: "user", content: line },
  })}\n`;

/** What happened to each registration, for the sender. */
export interface Delivery {
  readonly notified: number;
  readonly pruned: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * The line `send` adds after "Sent": who saw the notice, and where the mail waits otherwise.
 * The mail is stored either way, so nothing here is a failure.
 */
export const formatDelivery = (to: string, delivery: Delivery): string => {
  const notes = [
    ...delivery.pruned.map((reason) => `note: pruned a registration of ${to}: ${reason}`),
    ...delivery.skipped.map((reason) => `note: no notice to a session of ${to}: ${reason}`),
  ];
  const head =
    delivery.notified === 0
      ? `No live session of ${to} to notify: they see it at their next session start or prompt.`
      : `Notified ${delivery.notified} live session${delivery.notified === 1 ? "" : "s"} of ${to}.`;
  return [head, ...notes].join("\n");
};
