/**
 * `mshape msg watch | unwatch`, and the check that turns watches into mail. A watch is a file
 * under its address's mailbox (`<mailbox>/watches/<key>.json`), so it goes with the mailbox
 * when `track rm` removes it. The check runs for the whole repo when any session's inbox is
 * read, at most once a minute (a stamp under the mail directory), asks `gh` and `bd` once per
 * thing watched, and sends what `src/core/watch.ts` decides from `WATCH_SENDER`. Before a
 * message is written its event's key is created exclusively under `<watches>/sent/`: of two
 * sessions checking at once, one sends, and no restart sends an event again.
 */
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { mailboxDir, mailDir, TRACK_NAME } from "../core/layout.ts";
import type { Message } from "../core/mail.ts";
import {
  type BeadSeen,
  type Decided,
  decideBead,
  decideCi,
  decideMain,
  decidePr,
  decodeBead,
  decodePr,
  decodeRuns,
  decodeWatch,
  describeWatch,
  encodeWatch,
  eventKeys,
  formatWatches,
  isEventOf,
  type PrSeen,
  parseTarget,
  type Run,
  type Target,
  WATCH_SENDER,
  type Watch,
  watchKey,
} from "../core/watch.ts";
import { entries, fsUnless, storeMessage } from "./mail.ts";
import { type Caller, sessionAddress } from "./notices.ts";
import { fs, locate, refuse } from "./tracks.ts";

/** What a lookup found; `missing` when it doesn't exist; `unavailable` when gh or bd can't say. */
export type Lookup<A> =
  | { readonly found: A }
  | { readonly missing: string }
  | { readonly unavailable: string };

/** Where watches look: `gh` and `bd` for real, a fake in tests. */
export interface Observer {
  readonly pr: (cwd: string, pr: string) => Effect.Effect<Lookup<PrSeen>>;
  readonly bead: (cwd: string, id: string) => Effect.Effect<Lookup<BeadSeen>>;
  /** The full id of a commit GitHub has. */
  readonly commit: (cwd: string, sha: string) => Effect.Effect<Lookup<{ readonly sha: string }>>;
  /** Actions runs on one head, or on pushes to `main`, newest first. */
  readonly runs: (
    cwd: string,
    on: { readonly sha: string } | "main",
  ) => Effect.Effect<Lookup<ReadonlyArray<Run>>>;
}

/** A hook waits on this, so a hung `gh` must not hang the session's prompt for long. */
const TIMEOUT_MS = 10_000;

const tool = (
  env: Environment,
  cwd: string,
  command: ReadonlyArray<string>,
): Effect.Effect<{ readonly code: number; readonly stdout: string; readonly stderr: string }> =>
  Effect.sync(() => {
    try {
      const child = Bun.spawnSync([...command], {
        cwd,
        env: { ...env },
        stdout: "pipe",
        stderr: "pipe",
        timeout: TIMEOUT_MS,
      });
      return {
        code: child.exitCode ?? -1,
        stdout: child.stdout.toString(),
        stderr:
          child.exitCode === null
            ? `timed out after ${TIMEOUT_MS / 1000}s`
            : child.stderr.toString().trim(),
      };
    } catch (cause) {
      return { code: -1, stdout: "", stderr: `\`${command[0]}\` can't run: ${String(cause)}` };
    }
  });

/** A lookup from one command: `missing` when it failed saying so, `unavailable` otherwise. */
const lookup = <A>(
  env: Environment,
  cwd: string,
  command: ReadonlyArray<string>,
  missing: RegExp,
  what: string,
  decode: (text: string) => A | string,
): Effect.Effect<Lookup<A>> =>
  Effect.map(tool(env, cwd, command), (ran): Lookup<A> => {
    // The command up to its first flag: names what was asked, never the JSON fields.
    const end = command.findIndex((arg) => arg.startsWith("--"));
    const said = `\`${(end === -1 ? command : command.slice(0, end)).join(" ")}\``;
    if (ran.code !== 0)
      return missing.test(`${ran.stderr}\n${ran.stdout}`)
        ? { missing: `${what} doesn't exist` }
        : { unavailable: `${said} failed: ${ran.stderr || `exit ${ran.code}`}` };
    const decoded = decode(ran.stdout);
    return typeof decoded === "string"
      ? { unavailable: `${said} printed something unexpected (${decoded})` }
      : { found: decoded };
  });

const RUNS = "repos/{owner}/{repo}/actions/runs";

/** The environment gh and bd run in: the composition root's, a fake PATH in tests. */
export type Environment = Readonly<Record<string, string | undefined>>;

export const ghObserver = (env: Environment): Observer => ({
  pr: (cwd, pr) =>
    lookup(
      env,
      cwd,
      ["gh", "api", `repos/{owner}/{repo}/pulls/${pr}`],
      /HTTP 404/,
      `pull request #${pr}`,
      decodePr,
    ),
  bead: (cwd, id) =>
    lookup(
      env,
      cwd,
      ["bd", "show", id, "--json"],
      /not found|no issues found/,
      `bead ${id}`,
      decodeBead,
    ),
  commit: (cwd, sha) =>
    lookup(
      env,
      cwd,
      ["gh", "api", `repos/{owner}/{repo}/commits/${sha}`, "--jq", ".sha"],
      /No commit found|HTTP 404|HTTP 422/,
      `commit ${sha} on GitHub`,
      // An object, not the bare id: a decoder's string is its error.
      (text) => (/^[0-9a-f]{40}$/.test(text.trim()) ? { sha: text.trim() } : "not a commit id"),
    ),
  runs: (cwd, on) =>
    lookup(
      env,
      cwd,
      [
        "gh",
        "api",
        on === "main"
          ? `${RUNS}?branch=main&event=push&per_page=50`
          : `${RUNS}?head_sha=${on.sha}&per_page=50`,
      ],
      // Never: a head with no runs yet is an empty list, not a missing one.
      /(?!)/,
      "runs",
      decodeRuns,
    ),
});

const watchesDir = (common: string, address: string): string =>
  `${mailboxDir(common, address)}/watches`;
const watchPath = (common: string, address: string, watch: Target): string =>
  `${watchesDir(common, address)}/${watchKey(watch)}.json`;
const sentPath = (common: string, address: string, key: string): string =>
  `${watchesDir(common, address)}/sent/${key}`;
/** When the last check began: checks closer together than a minute are skipped. */
const checkedStamp = (common: string): string => `${mailDir(common)}/.watches-checked`;
/** When gh or bd last couldn't run and that was said: said at most once an hour. */
const notedStamp = (common: string): string => `${mailDir(common)}/.watches-noted`;

const CHECK_EVERY_MS = 60_000;
const NOTE_EVERY_MS = 3_600_000;

/** Written to a temporary name, then renamed: a reader never sees half a watch. */
const writeWatch = (path: string, watch: Watch) =>
  Effect.gen(function* () {
    const dir = path.slice(0, path.lastIndexOf("/"));
    yield* fs("create", dir, () => mkdir(dir, { recursive: true }));
    const temporary = `${path}.${process.pid}.tmp`;
    yield* fs("write", temporary, () => writeFile(temporary, encodeWatch(watch)));
    yield* fs("move", temporary, () => rename(temporary, path));
  });

interface Stored {
  readonly address: string;
  readonly path: string;
  readonly watch: Watch;
}

/** One address's watches, and the files there that aren't one. */
const readWatches = (common: string, address: string) =>
  Effect.gen(function* () {
    const dir = watchesDir(common, address);
    const stored: Array<Stored> = [];
    const unreadable: Array<string> = [];
    for (const file of (yield* entries(dir)).filter((name) => name.endsWith(".json"))) {
      const text = yield* fsUnless("read", `${dir}/${file}`, "ENOENT", undefined, () =>
        readFile(`${dir}/${file}`, "utf8"),
      );
      if (text === undefined) continue;
      const watch = decodeWatch(text);
      if (typeof watch === "string") unreadable.push(`${dir}/${file} is not a watch (${watch})`);
      else stored.push({ address, path: `${dir}/${file}`, watch });
    }
    return { stored, unreadable };
  });

/** A stamp's time, or undefined when it isn't there or isn't a time. */
const stampTime = (path: string) =>
  Effect.map(
    fsUnless("read", path, "ENOENT", "", () => readFile(path, "utf8")),
    (text) => {
      const time = Date.parse(text.trim());
      return Number.isNaN(time) ? undefined : time;
    },
  );

const stamp = (path: string, now: Date) =>
  fs("write", path, () =>
    mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true }).then(() =>
      writeFile(path, `${now.toISOString()}\n`),
    ),
  );

const watcher = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const { address } = yield* sessionAddress(cwd, caller).pipe(
      Effect.catchTag("TrackError", (error) =>
        refuse(`${error.reason}. Watch from a track's worktree, the main checkout or a review`),
      ),
    );
    const { common } = yield* locate(cwd);
    return { address, common };
  });

/** Whether a lookup at watch time lets the watch be made: refused when it doesn't exist. */
const exists = <A>(found: Lookup<A>, what: string) =>
  "found" in found
    ? Effect.succeed(found.found)
    : "missing" in found
      ? refuse(`${found.missing}: nothing to watch`)
      : refuse(`can't check that ${what} exists, so no watch was made: ${found.unavailable}`);

/** `msg watch <target>`: checks it exists, then stores it at this session's address. */
export const watchAdd = (
  cwd: string,
  args: ReadonlyArray<string>,
  caller: Caller,
  observer: Observer,
  now: Date,
) =>
  Effect.gen(function* () {
    const target = parseTarget(args);
    if (typeof target === "string") return yield* refuse(target);
    const { address, common } = yield* watcher(cwd, caller);
    let watch: Watch;
    if (target.kind === "pr") {
      yield* exists(yield* observer.pr(cwd, target.pr), `#${target.pr}`);
      watch = target;
    } else if (target.kind === "bead") {
      yield* exists(yield* observer.bead(cwd, target.id), `bead ${target.id}`);
      watch = target;
    } else if (target.kind === "ci")
      watch = {
        kind: "ci",
        sha: (yield* exists(yield* observer.commit(cwd, target.sha), `commit ${target.sha}`)).sha,
      };
    else watch = { kind: "main", since: now.toISOString(), red: false };
    const path = watchPath(common, address, watch);
    const already = yield* fsUnless("read", path, "ENOENT", undefined, () =>
      readFile(path, "utf8"),
    );
    if (already !== undefined) return `Already watching ${describeWatch(watch)} at ${address}.`;
    // Cleared before the watch exists, so no check sees the new watch beside an old ledger.
    const sentDir = sentPath(common, address, "");
    for (const file of (yield* entries(sentDir)).filter((name) =>
      isEventOf(name, eventKeys(watch)),
    )) {
      const ledger = sentPath(common, address, file);
      yield* fsUnless("remove", ledger, "ENOENT", undefined, () => unlink(ledger));
    }
    yield* writeWatch(path, watch);
    const when =
      watch.kind === "pr"
        ? "when it starts to conflict with its base, and when it merges or closes"
        : watch.kind === "bead"
          ? "when it closes"
          : watch.kind === "ci"
            ? "when CI on it ends, pass or fail"
            : "for each head of main whose CI fails, and when it is green again";
    return `Watching ${describeWatch(watch)} at ${address}: mail from ${WATCH_SENDER} ${when}. Checked when any session's inbox is read, at most once a minute.`;
  });

/** `msg unwatch <target>`: a short sha matches a ci watch it begins. */
export const watchRemove = (cwd: string, args: ReadonlyArray<string>, caller: Caller) =>
  Effect.gen(function* () {
    const target = parseTarget(args);
    if (typeof target === "string") return yield* refuse(target);
    const { address, common } = yield* watcher(cwd, caller);
    const { stored } = yield* readWatches(common, address);
    const match = stored.find(({ watch }) =>
      target.kind === "ci" && watch.kind === "ci"
        ? watch.sha.startsWith(target.sha)
        : watchKey(watch) === watchKey(target),
    );
    if (match === undefined)
      return yield* refuse(
        `${address} isn't watching ${describeWatch(target)}; \`mshape msg watch\` lists its watches`,
      );
    yield* fsUnless("remove", match.path, "ENOENT", undefined, () => unlink(match.path));
    return `Stopped watching ${describeWatch(match.watch)} at ${address}.`;
  });

export const watchList = (cwd: string, caller: Caller) =>
  Effect.gen(function* () {
    const { address, common } = yield* watcher(cwd, caller);
    const { stored, unreadable } = yield* readWatches(common, address);
    return [
      formatWatches(
        address,
        stored.map((entry) => entry.watch),
      ),
      ...unreadable.map((line) => `note: ${line}`),
    ].join("\n");
  });

/** What one check did: the mail it sent, and notes for the session that ran it. */
export interface Checked {
  readonly sent: ReadonlyArray<Message>;
  readonly notes: ReadonlyArray<string>;
}

/**
 * Checks every address's watches, unless another check began less than a minute ago, and
 * sends each new event as mail; `deliver` then pushes its notice. A gh or bd that can't run
 * loses no watch and sends nothing; it is one note, at most once an hour.
 */
export const checkWatches = (
  cwd: string,
  now: Date,
  observer: Observer,
  random: () => string,
  deliver: (message: Message) => Effect.Effect<unknown, unknown>,
) =>
  Effect.gen(function* () {
    const { common } = yield* locate(cwd);
    const addresses = (yield* entries(mailDir(common))).filter((name) => TRACK_NAME.test(name));
    const stored: Array<Stored> = [];
    const notes: Array<string> = [];
    for (const address of addresses) {
      const found = yield* readWatches(common, address);
      stored.push(...found.stored);
      notes.push(...found.unreadable.map((line) => `note: ${line}`));
    }
    if (stored.length === 0) return { sent: [], notes } satisfies Checked;
    const last = yield* stampTime(checkedStamp(common));
    if (last !== undefined && now.getTime() - last < CHECK_EVERY_MS && now.getTime() >= last)
      return { sent: [], notes } satisfies Checked;
    yield* stamp(checkedStamp(common), now);

    // Each thing watched is asked about once, however many addresses watch it.
    // Once gh or bd can't answer, it isn't asked again in this check: a hung gh costs the
    // prompt that started the check one timeout, not one per thing watched.
    const asked = new Map<string, Lookup<unknown>>();
    const down = new Map<string, string>();
    const ask = <A>(key: string, tool: "gh" | "bd", run: () => Effect.Effect<Lookup<A>>) =>
      Effect.gen(function* () {
        const cached = asked.get(key);
        if (cached !== undefined) return cached as Lookup<A>;
        const failed = down.get(tool);
        if (failed !== undefined)
          return { unavailable: `not asked, since ${failed}` } satisfies Lookup<A>;
        const fresh = yield* run();
        if ("unavailable" in fresh) down.set(tool, fresh.unavailable);
        asked.set(key, fresh);
        return fresh;
      });
    const decide = (watch: Watch): Effect.Effect<Decided | string> =>
      Effect.gen(function* () {
        const seen =
          watch.kind === "pr"
            ? yield* ask(`pr ${watch.pr}`, "gh", () => observer.pr(cwd, watch.pr))
            : watch.kind === "bead"
              ? yield* ask(`bead ${watch.id}`, "bd", () => observer.bead(cwd, watch.id))
              : watch.kind === "ci"
                ? yield* ask(`ci ${watch.sha}`, "gh", () => observer.runs(cwd, { sha: watch.sha }))
                : yield* ask("main", "gh", () => observer.runs(cwd, "main"));
        if ("missing" in seen) return seen.missing;
        if ("unavailable" in seen) return seen.unavailable;
        const value = seen.found;
        return watch.kind === "pr"
          ? decidePr(watch, value as PrSeen)
          : watch.kind === "bead"
            ? decideBead(watch, value as BeadSeen)
            : watch.kind === "ci"
              ? decideCi(watch, value as ReadonlyArray<Run>)
              : decideMain(watch, value as ReadonlyArray<Run>);
      });

    const sent: Array<Message> = [];
    const problems = new Set<string>();
    for (const entry of stored) {
      const decided = yield* decide(entry.watch);
      if (typeof decided === "string") {
        problems.add(`${describeWatch(entry.watch)}: ${decided}`);
        continue;
      }
      for (const event of decided.events) {
        const ledger = sentPath(common, entry.address, event.key);
        yield* fs("create", ledger, () =>
          mkdir(ledger.slice(0, ledger.lastIndexOf("/")), { recursive: true }),
        );
        const claimed = yield* fsUnless("write", ledger, "EEXIST", false, () =>
          writeFile(ledger, `${now.toISOString()}\n`, { flag: "wx" }).then(() => true),
        );
        if (!claimed) continue;
        const message = yield* storeMessage(
          common,
          WATCH_SENDER,
          entry.address,
          event.subject,
          event.body,
          now,
          random,
        );
        sent.push(message);
        // Stored first: a notice that can't be pushed leaves the mail for the next prompt.
        yield* Effect.ignore(deliver(message));
      }
      if (decided.next === undefined)
        yield* fsUnless("remove", entry.path, "ENOENT", undefined, () => unlink(entry.path));
      else if (encodeWatch(decided.next) !== encodeWatch(entry.watch))
        yield* writeWatch(entry.path, decided.next);
    }

    if (problems.size > 0) {
      const noted = yield* stampTime(notedStamp(common));
      if (noted === undefined || now.getTime() - noted >= NOTE_EVERY_MS || now.getTime() < noted) {
        yield* stamp(notedStamp(common), now);
        notes.push(
          `note: mshape msg watch couldn't check ${[...problems].join("; ")}. No watch was lost: each is checked again at the next inbox, and this note shows at most once an hour.`,
        );
      }
    }
    return { sent, notes } satisfies Checked;
  });
