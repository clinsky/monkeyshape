/**
 * `mshape msg send | inbox | read` against the mailbox under git's common directory, so every
 * checkout of the repo shares it. Each message is one file, written to a temporary name and
 * then hard-linked to its own, so a reader never sees half a message and two senders can't
 * overwrite each other. Reading renames it into `read/`, which is atomic too: once any session
 * at an address reads a message, it is read for all of them. The decisions are in
 * `src/core/mail.ts`.
 */
import { link, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import {
  handoffsStore,
  mailboxDir,
  mailboxReadDir,
  mailDir,
  messagePath,
  TRACK_NAME,
} from "../core/layout.ts";
import {
  addressLabel,
  decodeMessage,
  encodeMessage,
  knownAddresses,
  type Mailbox,
  MESSAGE_ID,
  type Message,
  messageId,
  recipientProblem,
  replyProblem,
  subjectProblem,
  threadOf,
  type Unreadable,
} from "../core/mail.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { type Caller, sessionAddress } from "./notices.ts";
import { fs, locate, refuse, registeredAddresses, reviewTracks, worktrees } from "./tracks.ts";

/** A caller Claude Code said nothing about: a terminal, or `track migrate`. */
const nobody = (now: Date): Caller => ({ identity: {}, claudeDir: "", now });

/** `run`, with one expected error code (`ENOENT`, `EEXIST`) as `fallback`, not a failure. */
export const fsUnless = <A, B>(
  operation: string,
  path: string,
  expected: string,
  fallback: B,
  run: () => Promise<A>,
) =>
  Effect.tryPromise({ try: run, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      (cause as NodeJS.ErrnoException).code === expected
        ? Effect.succeed<A | B>(fallback)
        : Effect.fail(new WorkspaceError({ operation, path, reason: String(cause) })),
    ),
  );

/** A directory's entries; a directory that doesn't exist yet is empty. */
export const entries = (path: string) =>
  fsUnless("list", path, "ENOENT", [] as Array<string>, () => readdir(path));

/** Hard links never replace a file, so an id taken by another sender is retried, not lost. */
const ATTEMPTS = 5;

/** `mailSend`'s optional settings. */
export interface SendOptions {
  readonly replyTo?: string | undefined;
}

export const mailSend = (
  cwd: string,
  to: string,
  subject: string,
  body: string,
  now: Date,
  random: () => string,
  caller: Caller = nobody(now),
  /**
   * What else this send says, one key per feature, so two features never fight over a
   * positional slot: `replyTo`, the id of the message this answers (`msg send --reply-to`).
   */
  options: SendOptions = {},
) =>
  Effect.gen(function* () {
    const problem = subjectProblem(subject);
    if (problem !== undefined) return yield* refuse(`${problem}`);
    const { common, repo } = yield* locate(cwd);
    const tracks = yield* reviewTracks(common);
    const known = knownAddresses(
      repo,
      yield* worktrees(repo),
      yield* entries(handoffsStore(common)),
      tracks,
      yield* registeredAddresses(common),
    );
    const unknown = recipientProblem(to, known, tracks);
    if (unknown !== undefined) return yield* refuse(`${unknown}`);
    // From the sender's address, so a reply reaches it: a review's, once a session moved there.
    const sender = yield* sessionAddress(cwd, caller).pipe(
      Effect.catchTag("TrackError", (error) =>
        refuse(`${error.reason}. Send from a track's worktree, the main checkout or a review`),
      ),
    );
    const { replyTo } = options;
    if (replyTo !== undefined) {
      const parent = (yield* allMessages(common)).get(replyTo);
      const cannot = replyProblem(replyTo, parent, sender.address);
      if (cannot !== undefined) return yield* refuse(cannot);
    }
    return yield* storeMessage(common, sender.address, to, subject, body, now, random, replyTo);
  });

/**
 * Every message in every mailbox, read or unread, by id: where a thread's earlier messages
 * are, since each is in its recipient's mailbox. An id two mailboxes share (two sends in one
 * second with the same 4 random digits) keeps the first found.
 */
export const allMessages = (common: string) =>
  Effect.gen(function* () {
    const byId = new Map<string, Message>();
    for (const address of (yield* entries(mailDir(common))).filter((name) => TRACK_NAME.test(name)))
      for (const dir of [mailboxDir(common, address), mailboxReadDir(common, address)])
        for (const message of (yield* readMessages(dir)).messages)
          if (!byId.has(message.id)) byId.set(message.id, message);
    return byId as ReadonlyMap<string, Message>;
  });

/**
 * Writes one message into `to`'s mailbox, with no check on who sends it or to whom: `mailSend`
 * checks a session's mail, and a watch sends from `WATCH_SENDER` to the address that watches.
 */
export const storeMessage = (
  common: string,
  from: string,
  to: string,
  subject: string,
  body: string,
  now: Date,
  random: () => string,
  replyTo?: string,
) =>
  Effect.gen(function* () {
    const dir = mailboxDir(common, to);
    yield* fs("create", dir, () => mkdir(dir, { recursive: true }));
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const id = messageId(now, random());
      const message: Message = {
        id,
        from,
        to,
        subject,
        body,
        created: now.toISOString(),
        ...(replyTo === undefined ? {} : { replyTo }),
      };
      const temporary = `${dir}/.${id}.${process.pid}.tmp`;
      const final = messagePath(common, to, id);
      yield* fs("write", temporary, () => writeFile(temporary, encodeMessage(message)));
      const linked = yield* fsUnless("write", final, "EEXIST", false, () =>
        link(temporary, final).then(() => true),
      );
      yield* fs("remove", temporary, () => unlink(temporary));
      if (linked) return message;
    }
    return yield* refuse(
      `${ATTEMPTS} message ids in a row were taken in ${to}'s mailbox; nothing was sent, so send again`,
    );
  });

const readMessages = (dir: string) =>
  Effect.gen(function* () {
    const files = (yield* entries(dir)).filter(
      (file) => file.endsWith(".json") && !file.startsWith("."),
    );
    const messages: Array<Message> = [];
    const unreadable: Array<Unreadable> = [];
    for (const file of files) {
      // Gone since the listing: another session read it, so it is no longer unread.
      const text = yield* fsUnless("read", `${dir}/${file}`, "ENOENT", undefined, () =>
        readFile(`${dir}/${file}`, "utf8"),
      );
      if (text === undefined) continue;
      const decoded = decodeMessage(text);
      if (typeof decoded === "string") unreadable.push({ file, reason: decoded });
      else messages.push(decoded);
    }
    return { messages, unreadable };
  });

/**
 * The unread mail at the caller's address. `unregistered` is set for a session Claude Code
 * identified that has no registration: its mail is its checkout's until it registers.
 */
export const mailInbox = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const here = yield* sessionAddress(cwd, caller);
    const { common } = yield* locate(cwd);
    return { ...here, ...(yield* readMessages(mailboxDir(common, here.address))) };
  });

/** The unread mail at `address`, from any checkout: for `review rm`, which lists it first. */
export const addressInbox = (cwd: string, address: string) =>
  Effect.flatMap(locate(cwd), ({ common }) => readMessages(mailboxDir(common, address)));

/**
 * Every mailbox's unread mail, from any checkout: each address's, and any left at a track or
 * review that is gone. Read-only: nothing is marked read.
 */
export const mailInboxAll = (cwd: string) =>
  Effect.gen(function* () {
    const { common, repo } = yield* locate(cwd);
    const known = knownAddresses(
      repo,
      yield* worktrees(repo),
      yield* entries(handoffsStore(common)),
      yield* reviewTracks(common),
      yield* registeredAddresses(common),
    );
    const boxes = (yield* entries(mailDir(common))).filter((name) => TRACK_NAME.test(name));
    const mailboxes: Array<Mailbox> = [];
    for (const address of [...new Set([...known, ...boxes])])
      mailboxes.push({
        address,
        known: known.includes(address),
        dir: mailboxDir(common, address),
        ...(yield* readMessages(mailboxDir(common, address))),
      });
    return mailboxes;
  });

/**
 * Reads message `id` at the caller's address and marks it read there, for every session at
 * it. Reading it again shows it again.
 */
export const mailRead = (cwd: string, id: string, caller: Caller) =>
  Effect.gen(function* () {
    if (!MESSAGE_ID.test(id))
      return yield* refuse(`\`${id}\` is not a message id; \`mshape msg inbox\` lists them`);
    const { address: track } = yield* sessionAddress(cwd, caller);
    const { common } = yield* locate(cwd);
    const unread = messagePath(common, track, id);
    const readDir = mailboxReadDir(common, track);
    const read = `${readDir}/${id}.json`;
    yield* fs("create", readDir, () => mkdir(readDir, { recursive: true }));
    // The rename is the mark: of two sessions reading at once, exactly one moves it.
    const moved = yield* fsUnless("move", unread, "ENOENT", false, () =>
      rename(unread, read).then(() => true),
    );
    const text = yield* fsUnless("read", read, "ENOENT", undefined, () => readFile(read, "utf8"));
    if (text === undefined)
      return yield* refuse(
        `no message ${id} for ${addressLabel(track)}; \`mshape msg inbox\` lists the unread ones`,
      );
    const message = decodeMessage(text);
    if (typeof message === "string") return yield* refuse(`${read} is not a message (${message})`);
    const thread =
      message.replyTo === undefined
        ? { earlier: [] }
        : threadOf(message, yield* allMessages(common));
    return { message, alreadyRead: !moved, thread };
  });
