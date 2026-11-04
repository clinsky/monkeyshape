/**
 * The mailbox's decisions: who a sender is, what a message may say, its id, and how the inbox
 * and a read message print. `src/adapters/mail.ts` does the I/O. The mailbox is the durable
 * source of truth for messages between tracks: a notice (a hook's unread subjects, later a
 * live notice) only ever names a message, and only `mshape msg read <id>` marks it read.
 */
import { mshapeCommand } from "./hooks.ts";
import {
  MAIN_ADDRESS,
  PR_NUMBER,
  reviewAddress,
  reviewOf,
  reviewPath,
  TRACK_NAME,
  trackOf,
} from "./layout.ts";
import type { Worktree } from "./tracks.ts";

export interface Message {
  readonly id: string;
  /** The sender's address: a track, `main` or `review-<n>`. */
  readonly from: string;
  /** The recipient's address. */
  readonly to: string;
  /** One line: it is what every notice shows. */
  readonly subject: string;
  readonly body: string;
  /** ISO 8601, UTC. */
  readonly created: string;
}

/** A subject is shown on one line in every notice, so it has to fit on one. */
export const SUBJECT_MAX = 120;

export const subjectProblem = (subject: string): string | undefined => {
  if (subject.trim() === "") return "the subject is empty: say in a few words what the message is";
  // Line breaks, tabs, escapes: the subject is printed into every session's context.
  if (/\p{Cc}/u.test(subject))
    return "the subject has a control character (a line break, tab or escape): keep it to one line of plain text and put the rest in the body";
  if (subject.length > SUBJECT_MAX)
    return `the subject is ${subject.length} characters; keep it to ${SUBJECT_MAX} and put the rest in the body`;
  return undefined;
};

/** `<yyyymmdd>-<hhmmss>-<4 hex>`: sorts by time, short enough to type, unique per second. */
export const MESSAGE_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/;

/** `random` is 4 hex digits from the caller, so the id stays a pure function of its inputs. */
export const messageId = (created: Date, random: string): string => {
  const iso = created.toISOString();
  return `${iso.slice(0, 10).replaceAll("-", "")}-${iso.slice(11, 19).replaceAll(":", "")}-${random}`;
};

/**
 * The address of the checkout this runs in: the track, `main` in the main checkout,
 * `review-<n>` in a review worktree. A session's registration overrides it (a session at
 * `main` that runs `mshape review <n>` moves); this is the fallback for a session that has
 * none, and for a terminal. Anywhere else (a worktree on the wrong branch, say) has no
 * address, since nobody could reply to it.
 */
export const directoryAddress = (
  repo: string,
  toplevel: string,
  worktrees: ReadonlyArray<Worktree>,
  track: { readonly track: string } | { readonly reason: string },
): { readonly address: string } | { readonly reason: string } => {
  if ("track" in track) return { address: track.track };
  if (toplevel === repo) return { address: MAIN_ADDRESS };
  const review = reviewPath(repo, "");
  const pr = toplevel.startsWith(review) ? toplevel.slice(review.length) : "";
  if (PR_NUMBER.test(pr) && worktrees.some((worktree) => worktree.path === toplevel))
    return { address: reviewAddress(pr) };
  return {
    reason: `${track.reason}. Only a track's worktree, the main checkout and a review worktree have an address`,
  };
};

/** The tracks a message can go to: those with a worktree, and those with a handoff. */
export const knownTracks = (
  repo: string,
  worktrees: ReadonlyArray<Worktree>,
  handoffs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const fromWorktrees = worktrees.flatMap((worktree) => trackOf(repo, worktree.path) ?? []);
  const fromHandoffs = handoffs.flatMap((file) =>
    file.endsWith(".md") && TRACK_NAME.test(file.slice(0, -3)) ? [file.slice(0, -3)] : [],
  );
  return [...new Set([...fromWorktrees, ...fromHandoffs])].sort();
};

/** Every address a message can go to: the tracks, `main`, and each review with a worktree. */
export const knownAddresses = (
  repo: string,
  worktrees: ReadonlyArray<Worktree>,
  handoffs: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const reviews = worktrees.flatMap((worktree) => {
    const prefix = reviewPath(repo, "");
    const pr = worktree.path.startsWith(prefix) ? worktree.path.slice(prefix.length) : "";
    return PR_NUMBER.test(pr) ? [reviewAddress(pr)] : [];
  });
  return [...knownTracks(repo, worktrees, handoffs), MAIN_ADDRESS, ...reviews.sort()];
};

export const recipientProblem = (to: string, known: ReadonlyArray<string>): string | undefined => {
  if (known.includes(to)) return undefined;
  const pr = reviewOf(to);
  if (pr !== undefined)
    return `no review of #${pr} to send to: \`${to}\` exists while \`mshape review ${pr}\`'s worktree does (addresses: ${known.join(", ")})`;
  return `no track \`${to}\` to send to (addresses: ${known.join(", ")}); \`mshape track list\` shows the tracks`;
};

/** How an address reads in a sentence: `track docs`, `main`, `review-12`. */
export const addressLabel = (address: string): string =>
  address === MAIN_ADDRESS || reviewOf(address) !== undefined ? address : `track ${address}`;

/** A message file's contents, or why it can't be one. Strict: an unknown key is refused. */
export const decodeMessage = (text: string): Message | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `not JSON: ${String(error)}`;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const record = value as Record<string, unknown>;
  const keys: ReadonlyArray<keyof Message> = ["id", "from", "to", "subject", "body", "created"];
  const missing = keys.filter((key) => typeof record[key] !== "string");
  if (missing.length > 0) return `missing or not a string: ${missing.join(", ")}`;
  const extra = Object.keys(record).filter((key) => !(keys as ReadonlyArray<string>).includes(key));
  if (extra.length > 0) return `unknown keys: ${extra.join(", ")}`;
  return record as unknown as Message;
};

export const encodeMessage = (message: Message): string => `${JSON.stringify(message, null, 2)}\n`;

/** Oldest first, so a thread reads in order. */
export const byCreated = (a: Message, b: Message): number =>
  a.created === b.created ? a.id.localeCompare(b.id) : a.created.localeCompare(b.created);

/** `2026-11-03 14:25 UTC`: minutes are enough to order a conversation. */
const when = (created: string): string => `${created.slice(0, 10)} ${created.slice(11, 16)} UTC`;

/** A file in the mailbox that isn't a message, said so rather than skipped. */
export interface Unreadable {
  readonly file: string;
  readonly reason: string;
}

/**
 * The unread messages, one line each, with the command that reads one. Empty when there are
 * none and `quiet` is set, so a hook adds nothing to a session with nothing to read.
 */
export const formatInbox = (
  address: string,
  messages: ReadonlyArray<Message>,
  unreadable: ReadonlyArray<Unreadable>,
  quiet: boolean,
): string => {
  const notes = unreadable.map(
    (entry) => `note: ${entry.file} in ${address}'s mailbox is not a message (${entry.reason})`,
  );
  if (messages.length === 0)
    return quiet && notes.length === 0
      ? ""
      : [`No unread messages for ${addressLabel(address)}.`, ...notes].join("\n");
  const sorted = [...messages].sort(byCreated);
  return [
    `Unread messages for ${addressLabel(address)}. Read one with \`${mshapeCommand(["msg", "read"])} <id>\`; until then it stays unread.`,
    ...sorted.map(
      (message) =>
        `  ${message.id}  from ${message.from}, ${when(message.created)}: ${message.subject}`,
    ),
    ...notes,
  ].join("\n");
};

/** One address's mailbox, for `msg inbox --all`. */
export interface Mailbox {
  readonly address: string;
  /** False for a mailbox whose track or review is gone: mail nobody will read unless someone acts. */
  readonly known: boolean;
  /** Where it is on disk: a gone address's mail can only be dealt with there. */
  readonly dir: string;
  readonly messages: ReadonlyArray<Message>;
  readonly unreadable: ReadonlyArray<Unreadable>;
}

/**
 * Every address's unread mail, for the main checkout and `/milestone`: grouped by address,
 * oldest first, then a summary line. Reading stays the address's own act, so it says where.
 */
export const formatAllInboxes = (mailboxes: ReadonlyArray<Mailbox>): string => {
  const listed = [...mailboxes]
    .filter((box) => box.messages.length > 0 || box.unreadable.length > 0)
    .sort((a, b) => a.address.localeCompare(b.address));
  if (listed.length === 0) return "No unread mail anywhere.";
  const unread = listed.reduce((sum, box) => sum + box.messages.length, 0);
  const boxes = listed.filter((box) => box.messages.length > 0).length;
  const junk = listed.reduce((sum, box) => sum + box.unreadable.length, 0);
  const gone = (box: Mailbox): string => {
    const pr = reviewOf(box.address);
    return pr === undefined
      ? ` (no such track: its worktree and handoff are gone; recreate it with \`${mshapeCommand(["track", "new", box.address])}\` to read this, or delete ${box.dir} if it is no longer wanted)`
      : ` (no review of #${pr} is running; \`${mshapeCommand(["review", pr])}\` from the main checkout moves a session there to read it, or delete ${box.dir} if it is no longer wanted)`;
  };
  return [
    ...listed.flatMap((box) => [
      `${box.address}: ${box.messages.length} unread${box.known ? "" : gone(box)}`,
      ...[...box.messages]
        .sort(byCreated)
        .map(
          (message) =>
            `  ${message.id}  from ${message.from}, ${when(message.created)}: ${message.subject}`,
        ),
      ...box.unreadable.map((entry) => `  note: ${entry.file} is not a message (${entry.reason})`),
    ]),
    `${unread} unread in ${boxes} mailbox${boxes === 1 ? "" : "es"}${junk === 0 ? "" : `, and ${junk} file${junk === 1 ? "" : "s"} that ${junk === 1 ? "isn't a message" : "aren't messages"}`}. Each address reads its own, from a session there, with \`${mshapeCommand(["msg", "read"])} <id>\`; this marks nothing read.`,
  ].join("\n");
};

export const formatMessage = (message: Message, alreadyRead: boolean): string =>
  [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Date: ${when(message.created)}`,
    `Subject: ${message.subject}`,
    ...(alreadyRead ? ["(already read)"] : []),
    "",
    message.body === "" ? "(no body)" : message.body,
  ].join("\n");

export const formatSent = (message: Message): string =>
  `Sent ${message.id} to ${message.to}: it stays unread in their mailbox until they run \`${mshapeCommand(["msg", "read", message.id])}\`.`;
