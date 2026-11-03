/**
 * Live notices: which sessions of a track get one, and what it says. A session registers
 * itself at start (`mshape msg register`, from its SessionStart hook), so which session is
 * which track is recorded by the session, never guessed from a socket or a directory; a
 * session that isn't in a track never registers, so other work on the machine never gets a
 * notice. At send time each registration is matched against Claude Code's own record of the
 * session (`~/.claude/sessions/<pid>.json`, undocumented, so read strictly and by protocol
 * version), and the socket and token come from there, never from the mailbox.
 * `src/adapters/notices.ts` does the I/O. Claude Code's socket never replies, so a session is
 * live when its record matches and its socket accepts the connection; nothing more is known.
 */
import { mshapeCommand } from "./hooks.ts";
import type { Message } from "./mail.ts";

/** One live session of a track, as `register` records it under the session registry. */
export interface Registration {
  readonly session: string;
  /** Claude Code's process: its session file is `<pid>.json`. */
  readonly pid: number;
  /** Tells a reused pid apart: a different process has a different start. */
  readonly procStart: string;
  readonly registered: string;
}

/** The fields of Claude Code's session file that a notice depends on. */
export interface ClaudeSession {
  readonly pid: number;
  readonly sessionId: string;
  readonly procStart: string;
  readonly peerProtocol: number;
  readonly messagingSocketPath: string;
}

/** The fields of the session's published key file (`<pid>.<hash>.key`) a sender uses. */
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
  const { session, pid, procStart, registered } = value;
  return typeof session === "string" &&
    SESSION_ID.test(session) &&
    typeof pid === "number" &&
    typeof procStart === "string" &&
    typeof registered === "string"
    ? { session, pid, procStart, registered }
    : undefined;
};

export const encodeRegistration = (registration: Registration): string =>
  `${JSON.stringify(registration, null, 2)}\n`;

/** Claude Code's session file, or undefined when it lacks a field a notice needs. */
export const decodeClaudeSession = (text: string): ClaudeSession | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { pid, sessionId, procStart, peerProtocol, messagingSocketPath } = value;
  return typeof pid === "number" &&
    typeof sessionId === "string" &&
    typeof procStart === "string" &&
    typeof peerProtocol === "number" &&
    typeof messagingSocketPath === "string"
    ? { pid, sessionId, procStart, peerProtocol, messagingSocketPath }
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

export const planNotice = (
  registration: Registration,
  session: ClaudeSession | undefined,
  key: ClaudeKey | undefined,
): Plan => {
  if (session === undefined) return { kind: "prune", reason: "its Claude Code session has ended" };
  // A /clear starts a new session id in the same process; a reused pid is another process.
  if (session.sessionId !== registration.session || session.procStart !== registration.procStart)
    return { kind: "prune", reason: "its process now runs another session" };
  if (session.peerProtocol !== PEER_PROTOCOL)
    return {
      kind: "skip",
      reason: `Claude Code speaks messaging protocol ${session.peerProtocol}; this mshape knows ${PEER_PROTOCOL}`,
    };
  if (key === undefined || key.procStart !== registration.procStart)
    return { kind: "skip", reason: "Claude Code published no key for it" };
  return {
    kind: "notify",
    target: {
      session: registration.session,
      socket: session.messagingSocketPath,
      token: key.peerToken,
    },
  };
};

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
