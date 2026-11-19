/**
 * Session addresses and live notices, whatever the harness. A session registers itself at
 * start (`mshape prime`, from its harness's session-start hook, or run by the agent) at the
 * address of the checkout it runs in: a track, `main`, `review-<track>` or `review-<n>`. From
 * then on its address is its registration, never its directory: a session at `main` that runs
 * `mshape review <n>` moves to the reviewer's address, and its mail and notices follow. A
 * session outside every address never registers, so other work on the machine never gets a
 * notice. Whether a registered session still runs, and how a notice reaches it, are its
 * harness's (`src/harnesses/harness.ts`); `src/adapters/notices.ts` does the I/O.
 */

import {
  type Harness,
  type Identity,
  type Invocation,
  type Registration,
  SESSION_KEY,
} from "../harnesses/harness.ts";
import { HARNESS_IDS, type HarnessId } from "../schemas/config.ts";
import { mshapeCommand } from "./hooks.ts";
import { isReviewAddress, MAIN_ADDRESS } from "./layout.ts";
import { addressLabel, type Message } from "./mail.ts";

export type { Registration };

/**
 * How long a new registration may run ahead of its harness's record of the session. The hook
 * can register before the harness writes its record (at start) or updates it (after /clear); a
 * send in that window must not prune a registration that is about to be right.
 */
export const REGISTRATION_GRACE_MS = 30_000;

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

const isHarnessId = (value: string): value is HarnessId =>
  (HARNESS_IDS as ReadonlyArray<string>).includes(value);

/**
 * A registry file's contents: a registration, one of a harness this mshape doesn't ship
 * (`foreign`: skipped with a note, never pruned by guess), or undefined for a file that is
 * neither. A 0.6.0 registration has no `harness` and is Claude Code's.
 */
export type Stored =
  | { readonly kind: "registration"; readonly registration: Registration }
  | { readonly kind: "foreign"; readonly harness: string; readonly session: string };

export const decodeRegistration = (text: string): Stored | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { harness = "claude-code", session, pid, endpoint, registered } = value;
  if (
    typeof harness !== "string" ||
    typeof session !== "string" ||
    !SESSION_KEY.test(session) ||
    typeof registered !== "string" ||
    (pid !== undefined && typeof pid !== "number") ||
    (endpoint !== undefined && typeof endpoint !== "string")
  )
    return undefined;
  if (!isHarnessId(harness)) return { kind: "foreign", harness, session };
  return {
    kind: "registration",
    registration: {
      harness,
      session,
      ...(typeof pid === "number" ? { pid } : {}),
      ...(typeof endpoint === "string" ? { endpoint } : {}),
      registered,
    },
  };
};

export const encodeRegistration = (registration: Registration): string =>
  `${JSON.stringify(registration, null, 2)}\n`;

/**
 * A registration's file name: keyed by harness and session, so two harnesses' ids never
 * collide. A 0.6.0 file is `<session>.json`; it is read as it is and replaced at the
 * session's next registration.
 */
export const registrationFile = (registration: Pick<Registration, "harness" | "session">) =>
  `${registration.harness}.${registration.session}.json`;

/** A registration, the address it is filed under, and its file there. */
export interface Placed {
  readonly address: string;
  readonly file: string;
  readonly registration: Registration;
}

const sameSession = (a: Identity | Registration, b: Registration): boolean =>
  a.harness === b.harness && a.session === b.session;

/**
 * Which registration is the caller's own. By harness and session id when the harness gave
 * one: a session filed twice (a move cut short between its write and its delete) is where it
 * was filed last. By pid alone only among registrations still running, and more than one is
 * ambiguous (a `/clear` just now: the process's old session and its new one). Without either,
 * nobody: the caller is never guessed from a directory or from who else is registered.
 */
export type Self =
  | { readonly kind: "anonymous" }
  | { readonly kind: "unregistered" }
  | { readonly kind: "registered"; readonly placed: Placed }
  | { readonly kind: "ambiguous"; readonly placed: ReadonlyArray<Placed> };

export const findSelf = (
  placed: ReadonlyArray<Placed>,
  identity: Identity | undefined,
  running: (entry: Placed) => boolean,
): Self => {
  const newest = (a: Placed, b: Placed) =>
    b.registration.registered.localeCompare(a.registration.registered);
  if (identity === undefined) return { kind: "anonymous" };
  if (identity.session !== undefined) {
    const [mine] = placed.filter((entry) => sameSession(identity, entry.registration)).sort(newest);
    return mine === undefined ? { kind: "unregistered" } : { kind: "registered", placed: mine };
  }
  if (identity.pid === undefined) return { kind: "anonymous" };
  const mine = placed.filter(
    (entry) =>
      entry.registration.harness === identity.harness &&
      entry.registration.pid === identity.pid &&
      running(entry),
  );
  if (mine.length > 1) return { kind: "ambiguous", placed: mine };
  return mine[0] === undefined ? { kind: "unregistered" } : { kind: "registered", placed: mine[0] };
};

/**
 * Who runs this command, from the harnesses that could: the one `--harness` names, else each
 * that claims it. Two claims are no identity (a harness started from another's shell inherits
 * its variables), and nothing is guessed. `missing` says what was looked for.
 */
export type Identified =
  | { readonly kind: "identified"; readonly identity: Identity }
  | { readonly kind: "unidentified"; readonly reason: string };

export const identifySession = (
  harnesses: ReadonlyArray<Harness>,
  invocation: Invocation,
): Identified => {
  const asked =
    invocation.harness === undefined
      ? harnesses
      : harnesses.filter((harness) => harness.id === invocation.harness);
  const claims = asked.flatMap((harness) => {
    const identity = harness.identify(invocation);
    return identity === undefined ? [] : [{ harness, identity }];
  });
  const [only, ...more] = claims;
  if (only !== undefined && more.length === 0)
    return { kind: "identified", identity: only.identity };
  if (only !== undefined)
    return {
      kind: "unidentified",
      reason: `${claims.map((claim) => claim.harness.name).join(" and ")} each claim the session running this, as when one was started from the other's shell, so none is taken. Run it from the session's own hook, which passes --harness`,
    };
  const looked = asked.map((harness) => harness.identifiedBy).join("; or ");
  return {
    kind: "unidentified",
    reason:
      asked.length === 0
        ? `no harness this mshape ships is ${invocation.harness}`
        : `nothing identified the session running this (looked for ${looked})`,
  };
};

/** Why a command has no address of its own: `reason` from `identifySession`. */
export const noIdentity = (reason: string): string =>
  `no session identity: ${reason}, so this has no address of its own and none is guessed`;

export const ambiguousSelf = (placed: ReadonlyArray<Placed>): string =>
  `which session runs this is ambiguous: process ${placed[0]?.registration.pid} has ${placed.length} running registrations (${placed.map((entry) => `session ${entry.registration.session} at ${entry.address}`).join(", ")}). Run it again from the session itself, where its harness gives its session id`;

/**
 * Where `mshape review` puts a session at `from`, `to` being the review's address
 * (`review-<track>`, else `review-<n>`): a session at `main` or at another review moves
 * there; one at a track stays, since its track's mail is its work. Undefined is no move, so a
 * reviewer already at `review-<track>` stays for that track's next PR.
 */
export const reviewMove = (from: string, to: string): string | undefined =>
  (from === MAIN_ADDRESS || isReviewAddress(from)) && from !== to ? to : undefined;

/**
 * What the inbox hook adds for a session that has an id but no registration: how to register,
 * so it gets live notices; until then its mail is its directory's.
 */
export const unregisteredNote = (session: string, address: string): string =>
  `note: this session (${session}) isn't registered, so it gets no live notices, and its mail is taken from its directory's address, ${addressLabel(address)}. Run \`${mshapeCommand(["msg", "register"])}\` to register it.`;

/** What `register` says when other running sessions share the address. */
export const alsoRegistered = (address: string, others: ReadonlyArray<string>): string =>
  `note: ${others.map((id) => `session ${id}`).join(", ")} ${others.length === 1 ? "is" : "are"} also registered at ${address}: each gets its notices, and a message one of you reads is read for all`;

/** One line, never the body: the recipient decides when to read it. */
export const noticeLine = (message: Message): string =>
  `[mshape] Message from ${message.from}: ${message.subject} (${mshapeCommand(["msg", "read", message.id])})`;

/**
 * A notice as a whole message, for a harness whose notice text monkeyshape writes in full
 * (Codex, pi; Claude Code wraps the line in its own): the maintainer's wording (#147). Says
 * where it came from and names no harness.
 */
export const standaloneNotice = (line: string): string =>
  `Another agent session sent a message: ${line}. This came from another agent session, not typed by your user.`;

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
