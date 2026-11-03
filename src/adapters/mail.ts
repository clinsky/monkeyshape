/**
 * `mshape msg send | inbox | read` against the mailbox under git's common directory, so every
 * checkout of the repo shares it. Each message is one file, written to a temporary name and
 * then hard-linked to its own, so a reader never sees half a message and two senders can't
 * overwrite each other. Reading renames it into `read/`, which is atomic too: once any session
 * of a track reads a message, it is read for all of them. The decisions are in
 * `src/core/mail.ts`.
 */
import {
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { Effect } from "effect";
import { handoffsStore, mailboxDir, mailboxReadDir, messagePath } from "../core/layout.ts";
import {
  decodeMessage,
  encodeMessage,
  knownTracks,
  MESSAGE_ID,
  type Message,
  messageId,
  recipientProblem,
  senderOf,
  subjectProblem,
  type Unreadable,
} from "../core/mail.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { fs, gitOk, locate, refuse, trackCurrent, worktrees } from "./tracks.ts";

const real = (path: string) => Effect.promise(() => realpath(path).catch(() => path));

/** `run`, with one expected error code (`ENOENT`, `EEXIST`) as `fallback`, not a failure. */
const fsUnless = <A, B>(
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
const entries = (path: string) =>
  fsUnless("list", path, "ENOENT", [] as Array<string>, () => readdir(path));

/** The track this directory belongs to, as a value: refusing is the caller's choice. */
const currentOrReason = (cwd: string) =>
  trackCurrent(cwd).pipe(
    Effect.map((track) => ({ track })),
    Effect.catchTag("TrackError", (error) => Effect.succeed({ reason: error.reason })),
  );

/** The directory's track, or a refusal saying that only a track has a mailbox. */
const ownTrack = (cwd: string) =>
  Effect.flatMap(currentOrReason(cwd), (found) =>
    "track" in found
      ? Effect.succeed(found.track)
      : refuse(`${found.reason}. Only a track has a mailbox: run this from its worktree`),
  );

/** Hard links never replace a file, so an id taken by another sender is retried, not lost. */
const ATTEMPTS = 5;

export const mailSend = (
  cwd: string,
  to: string,
  subject: string,
  body: string,
  now: Date,
  random: () => string,
) =>
  Effect.gen(function* () {
    const problem = subjectProblem(subject);
    if (problem !== undefined) return yield* refuse(`${problem}`);
    const { common, repo } = yield* locate(cwd);
    const registered = yield* worktrees(repo);
    const tracks = knownTracks(repo, registered, yield* entries(handoffsStore(common)));
    const unknown = recipientProblem(to, tracks);
    if (unknown !== undefined) return yield* refuse(`${unknown}`);
    const here = yield* real(yield* gitOk(cwd, ["rev-parse", "--show-toplevel"]));
    // git's path for this checkout, in the layout's terms (worktrees() resolved them alike).
    let toplevel = here;
    for (const worktree of registered)
      if ((yield* real(worktree.path)) === here) toplevel = worktree.path;
    const sender = senderOf(repo, toplevel, registered, yield* currentOrReason(cwd));
    if ("reason" in sender) return yield* refuse(`${sender.reason}`);
    const dir = mailboxDir(common, to);
    yield* fs("create", dir, () => mkdir(dir, { recursive: true }));
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const id = messageId(now, random());
      const message: Message = {
        id,
        from: sender.from,
        to,
        subject,
        body,
        created: now.toISOString(),
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

/** The unread mail of this directory's track. */
export const mailInbox = (cwd: string) =>
  Effect.gen(function* () {
    const track = yield* ownTrack(cwd);
    const { common } = yield* locate(cwd);
    return { track, ...(yield* readMessages(mailboxDir(common, track))) };
  });

/** Reads message `id` and marks it read for the whole track. Reading it again shows it again. */
export const mailRead = (cwd: string, id: string) =>
  Effect.gen(function* () {
    if (!MESSAGE_ID.test(id))
      return yield* refuse(`\`${id}\` is not a message id; \`mshape msg inbox\` lists them`);
    const track = yield* ownTrack(cwd);
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
        `no message ${id} for track ${track}; \`mshape msg inbox\` lists the unread ones`,
      );
    const message = decodeMessage(text);
    if (typeof message === "string") return yield* refuse(`${read} is not a message (${message})`);
    return { message, alreadyRead: !moved };
  });
