/**
 * Session addresses: registration (`mshape prime`, `mshape msg register`), where a session's
 * mail goes, the move `mshape review` makes, and the notices `msg send` pushes to an
 * address's live sessions. The registry lives under git's common directory
 * (`sessions/<address>/<harness>.<session>.json`); whether a session still runs and how a
 * notice reaches it are asked of its harness (`src/adapters/harnesses/`). Nothing here fails a
 * send: the mail is already stored, so every problem becomes a note. Only `send` prunes the
 * registry, and `review` and `register` move or replace a session's own registration; reads
 * never change it. The decisions are in `src/core/notices.ts`.
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
import * as Effect from "effect/Effect";
import { mshapeCommand } from "../core/hooks.ts";
import {
  isReviewAddress,
  reviewerAddress,
  sessionPath,
  sessionsDir,
  TRACK_NAME,
  trackOf,
  trackSessionsDir,
  worktreePath,
} from "../core/layout.ts";
import { directoryAddress, type Message, reviewWorktreeAddress } from "../core/mail.ts";
import {
  alsoRegistered,
  ambiguousSelf,
  type Delivery,
  decodeRegistration,
  encodeRegistration,
  findSelf,
  noIdentity,
  noticeLine,
  type Placed,
  type Registration,
  registrationFile,
  reviewMove,
  type Self,
  type Stored,
} from "../core/notices.ts";
import { type Identity, SESSION_KEY } from "../harnesses/harness.ts";
import type { Harnesses } from "./harnesses/index.ts";
import {
  fs,
  gitOk,
  locate,
  refuse,
  reviewTracks,
  trackCurrent,
  trackNames,
  worktrees,
} from "./tracks.ts";

/** Symlinks resolved; a path that doesn't exist stays as it is. */
const real = (path: string) => Effect.promise(() => realpath(path).catch(() => path));

/** A file's text, or undefined when it can't be read. */
const text = (path: string) => Effect.promise(() => readFile(path, "utf8").catch(() => undefined));

const list = (path: string) => Effect.promise(() => readdir(path).catch(() => [] as Array<string>));

/**
 * Who runs a command, and how to tell whether a registration's session still runs. `identity`
 * is undefined when no harness identified the session; `unidentified` says why.
 */
export interface Caller {
  readonly identity: Identity | undefined;
  readonly unidentified?: string;
  readonly harnesses: Harnesses;
  readonly now: Date;
}

const whyUnidentified = (caller: Caller): string =>
  noIdentity(caller.unidentified ?? "no harness identified the session running this");

/** The reviewer addresses that still mean something: a review worktree's, or a live track's. */
const liveReviewAddresses = (repo: string, common: string) =>
  Effect.gen(function* () {
    const tracks = yield* reviewTracks(common);
    const all = yield* worktrees(repo);
    return [
      ...all.flatMap((worktree) => reviewWorktreeAddress(repo, worktree.path, tracks) ?? []),
      // review-<track> is held between the track's PRs, for as long as the track has a worktree.
      ...all.flatMap((worktree) => {
        const track = trackOf(repo, worktree.path);
        return track === undefined ? [] : [reviewerAddress(track)];
      }),
    ];
  });

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
    const track = yield* trackCurrent(cwd).pipe(
      Effect.map((name) => ({ track: name })),
      Effect.catchTag("TrackError", (error) => Effect.succeed({ reason: error.reason })),
    );
    const { common } = yield* locate(cwd);
    return directoryAddress(repo, toplevel, registered, track, yield* reviewTracks(common));
  });

/** Every registration at every address, decoded; files that aren't one are left alone. */
const allPlaced = (common: string) =>
  Effect.gen(function* () {
    const placed: Array<Placed> = [];
    for (const address of yield* list(sessionsDir(common))) {
      if (!TRACK_NAME.test(address)) continue;
      for (const { file, stored } of yield* registrations(trackSessionsDir(common, address)))
        if (stored?.kind === "registration")
          placed.push({ address, file, registration: stored.registration });
    }
    return placed;
  });

/**
 * Whether a registration's session still runs, by its harness: anything but `gone` counts, so
 * a session whose harness can't say is never taken for ended.
 */
const running = (harnesses: Harnesses, registration: Registration, now: Date) => {
  const io = harnesses.io(registration.harness);
  return io === undefined
    ? Effect.succeed(true)
    : Effect.map(io.status(registration, now), (status) => status.kind !== "gone");
};

const runningNow = (caller: Caller, registration: Registration) =>
  running(caller.harnesses, registration, caller.now);

/** The caller's own registration, found by `findSelf` over the whole registry. */
const selfIn = (placed: ReadonlyArray<Placed>, caller: Caller) =>
  Effect.gen(function* () {
    const running = new Set<Placed>();
    if (caller.identity?.session === undefined && caller.identity?.pid !== undefined)
      for (const entry of placed)
        if (
          entry.registration.pid === caller.identity?.pid &&
          (yield* runningNow(caller, entry.registration))
        )
          running.add(entry);
    return findSelf(placed, caller.identity, (entry) => running.has(entry));
  });

/** What the registry keeps of a session: what its harness told, and when. */
const recordOf = (identity: Identity, session: string, now: Date): Registration => ({
  harness: identity.harness,
  session,
  ...(identity.pid === undefined ? {} : { pid: identity.pid }),
  ...(identity.endpoint === undefined ? {} : { endpoint: identity.endpoint }),
  registered: now.toISOString(),
});

/** Writes a registration under `address` by atomic rename, so a reader never sees half one. */
const writeRegistration = (common: string, address: string, registration: Registration) =>
  Effect.gen(function* () {
    const dir = trackSessionsDir(common, address);
    const file = registrationFile(registration);
    const path = sessionPath(common, address, file);
    const temporary = `${dir}/.${file}.${process.pid}.tmp`;
    yield* fs("create", dir, () => mkdir(dir, { recursive: true }));
    yield* fs("write", temporary, () => writeFile(temporary, encodeRegistration(registration)));
    yield* fs("write", path, () => rename(temporary, path));
  });

const removeRegistration = (common: string, placed: Placed) => {
  const path = sessionPath(common, placed.address, placed.file);
  return Effect.promise(() => unlink(path).catch(() => undefined));
};

/**
 * Where the caller's mail is: its registration's address, or else its checkout's.
 * `unregistered` is set for a caller its harness identified that has no registration, for the
 * inbox hook to say so. Fails only when neither address exists, with the directory's reason.
 */
export const sessionAddress = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const directory = yield* directoryAddressOf(cwd);
    const { common } = yield* locate(cwd);
    const self = yield* selfIn(yield* allPlaced(common), caller);
    if (self.kind === "registered") return { address: self.placed.address };
    if ("reason" in directory) return yield* refuse(directory.reason);
    const session = caller.identity?.session;
    if (self.kind !== "unregistered" || session === undefined)
      return { address: directory.address };
    return { address: directory.address, unregistered: { session } };
  });

/**
 * Records this session at its address, so `send` can reach it: where it is already
 * registered (a compaction or a resume keeps the session id, and with it a review's address),
 * else its checkout's. Outside every address it does nothing (undefined); a problem is
 * returned as a note, never a failure, since it runs at session start. What the harness told
 * (`identify`) is all it records: whether the session still runs is asked of the harness at
 * send time, so the hook never waits on the harness's own record.
 */
export const register = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const { identity } = caller;
    const session = identity?.session;
    if (identity === undefined || session === undefined)
      return `note: mshape msg register: ${whyUnidentified(caller)}`;
    if (!SESSION_KEY.test(session))
      return `note: mshape msg register: \`${session}\` can't be a registry file name; this session gets no live notices`;
    // Outside a repo, as outside every address: nothing to register, and nothing to say.
    const directory = yield* directoryAddressOf(cwd).pipe(
      Effect.catchTag("TrackError", (error) => Effect.succeed({ reason: error.reason })),
    );
    if ("reason" in directory) return undefined;
    const { common } = yield* locate(cwd);
    const placed = yield* allPlaced(common);
    const self = yield* selfIn(placed, caller);
    // A review whose worktree went without `review rm` is no address any more: start over here.
    const { repo } = yield* locate(cwd);
    const at = self.kind === "registered" ? self.placed.address : undefined;
    const reviewGone =
      at !== undefined &&
      isReviewAddress(at) &&
      !(yield* liveReviewAddresses(repo, common)).includes(at);
    const address =
      self.kind === "registered" && !reviewGone ? self.placed.address : directory.address;
    const registration = recordOf(identity, session, caller.now);
    yield* writeRegistration(common, address, registration);
    const file = registrationFile(registration);
    // A move cut short left a copy elsewhere, or 0.6.0 filed it by session alone: this
    // session is where it was just written.
    for (const entry of placed)
      if (
        entry.registration.harness === identity.harness &&
        entry.registration.session === session &&
        (entry.address !== address || entry.file !== file)
      )
        yield* removeRegistration(common, entry);
    const others: Array<string> = [];
    for (const entry of placed)
      if (
        entry.address === address &&
        !(
          entry.registration.harness === identity.harness && entry.registration.session === session
        ) &&
        !(identity.pid !== undefined && entry.registration.pid === identity.pid) &&
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
    const { identity } = caller;
    const session = identity?.session;
    if (identity === undefined || session === undefined)
      return [
        `note: no session moved to ${to}: this session isn't registered, and its harness gave no session id to register it with`,
      ];
    yield* writeRegistration(common, to, recordOf(identity, session, caller.now));
    return [`session ${session}: ${from} -> ${to} (it wasn't registered; now it is)`];
  });

/**
 * The move `mshape review <pr>` makes, worked out before the review's worktree is touched,
 * so an ambiguous caller is refused before anything happens. `apply` moves the session (a
 * write at the new address, then the delete) and says what it did.
 */
export const planReviewMove = (cwd: string, caller: Caller, to: string) =>
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
    const move = from === undefined ? undefined : reviewMove(from, to);
    const none = Effect.succeed([] as ReadonlyArray<string>);
    if (move === undefined || from === undefined) return { apply: none };
    if (self.kind === "anonymous")
      return {
        apply: Effect.succeed([`note: no session moved to ${move}: ${whyUnidentified(caller)}`]),
      };
    return { apply: moveSession(common, caller, self, from, move) };
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
    if (self.kind === "anonymous")
      return yield* refuse(`nothing to move: ${whyUnidentified(caller)}`);
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

/** Every registration file of an address, decoded; undefined for a file that isn't one. */
const registrations = (dir: string) =>
  Effect.gen(function* () {
    const found: Array<{ file: string; stored: Stored | undefined }> = [];
    for (const file of yield* list(dir)) {
      if (!file.endsWith(".json") || file.startsWith(".")) continue;
      const raw = yield* text(`${dir}/${file}`);
      found.push({ file, stored: raw === undefined ? undefined : decodeRegistration(raw) });
    }
    return found;
  });

/** Only an address reaches the registry: an empty or odd one would address all of it. */
const validTrack = (track: string) =>
  TRACK_NAME.test(track)
    ? Effect.void
    : refuse(`\`${track}\` is not an address, so its session registry can't be read`);

/**
 * The ids of sessions running in `track`, for `track rm`, which refuses while one would lose
 * its worktree. Two sources: the track's registrations still running by their harness (a
 * session whose harness can't say, or this mshape doesn't ship, counts), by the same rule
 * `send` uses; and any session a harness sees running inside the track's worktree, registered
 * or not. Nothing is sent, and nothing removed: only `send` prunes.
 */
export const liveSessions = (cwd: string, track: string, harnesses: Harnesses, now: Date) =>
  Effect.gen(function* () {
    yield* validTrack(track);
    const { common, repo } = yield* locate(cwd);
    const dir = trackSessionsDir(common, track);
    const live = new Set<string>();
    for (const { stored } of yield* registrations(dir)) {
      if (stored?.kind === "foreign") live.add(stored.session);
      else if (stored !== undefined && (yield* running(harnesses, stored.registration, now)))
        live.add(stored.registration.session);
    }
    const worktree = yield* real(worktreePath(repo, track));
    for (const harness of harnesses.list) {
      const io = harnesses.io(harness.id);
      if (io !== undefined) for (const id of yield* io.runningIn(worktree)) live.add(id);
    }
    return [...live].sort();
  });

/** Deletes an address's session registry; how many registrations it held. For `track rm` and `review rm`. */
export const removeSessions = (cwd: string, track: string) =>
  Effect.gen(function* () {
    yield* validTrack(track);
    const { common } = yield* locate(cwd);
    const dir = trackSessionsDir(common, track);
    const held = (yield* registrations(dir)).filter((entry) => entry.stored !== undefined);
    yield* fs("remove", dir, () => rm(dir, { recursive: true, force: true }));
    return held.length;
  });

/**
 * Tells every live session registered for `track`, each through its own harness, and prunes
 * registrations whose session is gone. A registration of a harness this mshape doesn't ship
 * is skipped with a note, never pruned. Never fails: whatever goes wrong is in the returned
 * delivery's notes.
 */
export const notifyTrack = (
  common: string,
  track: string,
  line: string,
  harnesses: Harnesses,
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
    const nameOf = (id: string) => harnesses.list.find((harness) => harness.id === id)?.name ?? id;
    for (const { file, stored } of yield* registrations(dir)) {
      if (stored === undefined) {
        yield* prune(file, `${file} is not a registration`);
        continue;
      }
      if (stored.kind === "foreign") {
        skipped.push(
          `session ${stored.session}: its harness, ${stored.harness}, isn't one this mshape ships; kept`,
        );
        continue;
      }
      const { registration } = stored;
      const who = `session ${registration.session}`;
      const io = harnesses.io(registration.harness);
      if (io === undefined) {
        skipped.push(
          `${who}: this mshape can't reach ${nameOf(registration.harness)} sessions; kept`,
        );
        continue;
      }
      const status = yield* io.status(registration, now);
      if (status.kind === "gone") yield* prune(file, `${who}: ${status.reason}`);
      else if (status.kind === "unknown") skipped.push(`${who}: ${status.reason}; kept`);
      else if (status.kind === "pending")
        skipped.push(
          `${who}: it registered just now, before ${nameOf(registration.harness)} recorded it; kept`,
        );
      else {
        const sent = yield* io.notify(registration, line);
        if (sent.ok) notified++;
        else if (sent.gone) yield* prune(file, `${who}: ${sent.reason}`);
        else skipped.push(`${who}: ${sent.reason}`);
      }
    }
    return { notified, pruned, skipped } satisfies Delivery;
  });

/** After `send` stored `message`: a notice to each live session of its recipient. */
export const notifyRecipient = (cwd: string, message: Message, harnesses: Harnesses, now: Date) =>
  Effect.flatMap(locate(cwd), ({ common }) =>
    notifyTrack(common, message.to, noticeLine(message), harnesses, now),
  );
