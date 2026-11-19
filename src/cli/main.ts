#!/usr/bin/env bun
/** The `mshape` executable: the composition root, and the only place effects are run. */
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import pkg from "../../package.json" with { type: "json" };
import {
  BASELINE_FILE,
  readBaseline,
  readChangedLines,
  writeBaseline,
} from "../adapters/baseline.ts";
import { withBeadsExport } from "../adapters/beads.ts";
import { findConfig, loadConfig } from "../adapters/config.ts";
import { reviewPost, scanFile } from "../adapters/denylist.ts";
import { depBump } from "../adapters/dep.ts";
import { runGate } from "../adapters/gate.ts";
import { harnesses } from "../adapters/harnesses/index.ts";
import { initRepo, vendoredSpec } from "../adapters/init.ts";
import { ownRoot, recordedSums, runningCompiled } from "../adapters/launch.ts";
import { mailInbox, mailInboxAll, mailRead, mailSend } from "../adapters/mail.ts";
import { migrateConfig } from "../adapters/migrate.ts";
import {
  type Caller,
  enterTrack,
  liveSessions,
  notifyRecipient,
  register,
  removeSessions,
  sessionAddress,
} from "../adapters/notices.ts";
import { primeText } from "../adapters/prime.ts";
import { runTool } from "../adapters/process.ts";
import { packSource, packWorkingTree } from "../adapters/release.ts";
import { reviewNew, reviewRm } from "../adapters/reviews.ts";
import { listShapeRules } from "../adapters/shapeRules.ts";
import { syncAll } from "../adapters/sync.ts";
import { CI_TIMING, trackPr } from "../adapters/trackPr.ts";
import {
  type CarryMessages,
  currentTrackOf,
  locate,
  type TrackSessions,
  trackList,
  trackMigrate,
  trackNames,
  trackNew,
  trackRm,
} from "../adapters/tracks.ts";
import { checkWatches, ghObserver, watchAdd, watchList, watchRemove } from "../adapters/watch.ts";
import { loadSnapshot } from "../adapters/workspace.ts";
import { assess, CHECKS, evaluate, prerequisites } from "../core/check.ts";
import { OWNABLE_FILES } from "../core/conventions.ts";
import { garden } from "../core/garden.ts";
import { cacheRoot } from "../core/launch.ts";
import { CLAUDE_SKILLS_LINK, isReviewAddress, SKILLS_DIR } from "../core/layout.ts";
import {
  formatAllInboxes,
  formatInbox,
  formatMessage,
  formatSent,
  type Message,
} from "../core/mail.ts";
import type { CheckName } from "../core/model.ts";
import { formatDelivery, unregisteredNote } from "../core/notices.ts";
import { initBaseline, tighten } from "../core/ratchet.ts";
import { packVersion } from "../core/release.ts";
import { formatCheck, formatGarden, formatViolation, tallyByRule } from "../core/report.ts";
import { formatRules } from "../core/rules/engine.ts";
import { RULES } from "../core/rules/registry.ts";
import { nextStep, REPO_NAME } from "../core/scaffold.ts";
import { formatCollisions, formatSync, SKILL_NAME } from "../core/skills.ts";
import { formatSyncPlan } from "../core/sync.ts";
import { headingProblems } from "../core/trackPr.ts";
import { HARNESS_IDS, PACK_IDS, shapeJsonSchema } from "../schemas/config.ts";
import { type ConfigError, TrackError, WorkspaceError } from "../schemas/errors.ts";
import { caller, hookCaller, setInvokedBy } from "./session.ts";

/** What a command returns: the text to print, and the exit code (0 prints to stdout). */
interface Outcome {
  readonly output: string;
  readonly code: number;
}

/**
 * One `mshape` command. A new command is one entry in `COMMANDS`, and the help is generated
 * from the table, so a command can't ship without its usage and no two tracks edit one switch.
 */
interface Command {
  readonly name: string;
  /** Its lines in the help: each form indented two spaces, what it does six. */
  readonly usage: string;
  readonly run: (
    root: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<Outcome, ConfigError | WorkspaceError | TrackError>;
}

const FLAGS = `  --config <path>   For check, baseline, garden and rules: use this config instead of ./shape.toml
                    (trying a repo before adopting).`;

/** Every command's usage, in table order. A function, since the table is declared below. */
export const help = (): string =>
  [`mshape ${pkg.version}`, "", ...COMMANDS.map((command) => command.usage), "", FLAGS].join("\n");

const usage = (): Outcome => ({ output: help(), code: 2 });

const parseOnly = (args: ReadonlyArray<string>): ReadonlyArray<CheckName> | string => {
  const index = args.indexOf("--only");
  if (index === -1) return CHECKS;
  const names = (args[index + 1] ?? "").split(",").filter(Boolean);
  const unknown = names.filter((name) => !(CHECKS as ReadonlyArray<string>).includes(name));
  return unknown.length > 0 || names.length === 0
    ? `unknown check(s): ${unknown.join(", ") || "(none given)"}`
    : (names as ReadonlyArray<CheckName>);
};

/**
 * The package's own directory, with `template/` and `skills/`: beside `src/` under Bun, or
 * unpacked by the compiled binary's entry before it imports this module.
 */
const PACKAGE_ROOT = ownRoot();

const WORKFLOW_URL = `${pkg.homepage.replace(/#.*$/, "")}/blob/main/docs/workflow.md`;

/**
 * When this mshape runs from a git checkout whose code isn't the release its version names,
 * the development version a pack of it gets (`packVersion`). Undefined for an installed
 * package, or a checkout exactly at its release tag, which npm has.
 */
const checkoutVersion = () =>
  Effect.gen(function* () {
    const top = yield* runTool(PACKAGE_ROOT, ["git", "rev-parse", "--show-toplevel"]);
    if (top.code !== 0) return undefined;
    const [here, root] = yield* Effect.promise(() =>
      Promise.all([realpath(PACKAGE_ROOT), realpath(top.stdout.trim())]),
    );
    if (here !== root) return undefined;
    const version = packVersion(yield* packSource(PACKAGE_ROOT));
    return version === pkg.version ? undefined : version;
  });

/** A pack of this checkout, to vendor when it isn't the release (`checkoutVersion`). */
const checkoutPack = () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-init-")));
    const tarball = yield* packWorkingTree(PACKAGE_ROOT, dir);
    return {
      tarball,
      cleanup: Effect.promise(() => rm(dir, { recursive: true, force: true })),
    };
  });

const init = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fromFlag = args.indexOf("--from");
    const from = fromFlag === -1 ? undefined : args[fromFlag + 1];
    // A forgotten value would silently install from the registry, which --from exists to avoid.
    if (fromFlag !== -1 && (from === undefined || from.startsWith("--")))
      return {
        output: "mshape init: --from needs a value: a tarball path or a spec bun install accepts",
        code: 2,
      };
    const packFlag = args.indexOf("--pack");
    const pack = packFlag === -1 ? "typescript" : args[packFlag + 1];
    if (pack === undefined || !(PACK_IDS as ReadonlyArray<string>).includes(pack))
      return {
        output: `mshape init: --pack takes one of ${PACK_IDS.join(", ")}${pack === undefined ? "" : `, not '${pack}'`}`,
        code: 2,
      };
    // --from names the npm package a TypeScript repo installs; another pack's repo installs none.
    if (fromFlag !== -1 && pack !== "typescript")
      return {
        output: `mshape init: --from sets the monkeyshape package a TypeScript repo installs, and a ${pack} repo installs none: drop --from`,
        code: 2,
      };
    const flagged = new Set([fromFlag, packFlag].flatMap((at) => (at === -1 ? [] : [at, at + 1])));
    const positional = args.filter((_, i) => !flagged.has(i));
    const [name, ...extra] = positional;
    if (name === undefined || !REPO_NAME.test(name) || extra.length > 0)
      return {
        output: `mshape init: give the new repo's name in lowercase words joined by hyphens, e.g. \`mshape init my-app\` (got ${positional.length === 0 ? "nothing" : positional.map((arg) => `'${arg}'`).join(" ")})`,
        code: 2,
      };
    // A file, as a bare path or a file: spec, is the package tarball: vendored, since an
    // absolute path in package.json would resolve only on this machine. Another bare path (a
    // directory) is resolved from here, as bun would resolve it from the new repo; any other
    // spec (a registry version, github:) is passed on as given.
    const path = from?.startsWith("file:") ? from.slice("file:".length) : from;
    const local =
      path === undefined || (path.includes(":") && !from?.startsWith("file:"))
        ? undefined
        : resolve(root, path);
    const given =
      local !== undefined && (yield* Effect.promise(() => Bun.file(local).exists()))
        ? local
        : undefined;
    // From a checkout that isn't the release, npm's package of this version isn't this code:
    // vendor a pack of the checkout instead, as --from would. Only a TypeScript repo installs it.
    const dev = yield* checkoutVersion();
    const checkout =
      dev !== undefined && from === undefined && pack === "typescript"
        ? yield* checkoutPack()
        : undefined;
    // The repo pins the mshape running init: a release's binary with the sums install.sh or the
    // launcher verified it against; any other build by its version alone.
    const pin = {
      version: dev ?? pkg.version,
      // shape-ignore local/bun-through-bunpath: reads the running binary's recorded sums, never spawns it
      sums: runningCompiled() ? yield* recordedSums(process.execPath) : undefined,
    };
    const tarball = given ?? checkout?.tarball;
    const spec =
      tarball !== undefined ? vendoredSpec(tarball) : local !== undefined ? `file:${local}` : from;
    const tools = pkg.devDependencies;
    const result = yield* initRepo(
      `${root}/${name}`,
      name,
      PACKAGE_ROOT,
      {
        bun: Bun.version,
        monkeyshape: spec ?? pkg.version,
        effect: tools.effect,
        biome: tools["@biomejs/biome"],
        typescript: tools.typescript,
        typesBun: tools["@types/bun"],
      },
      tarball,
      pack,
      pin,
    ).pipe(Effect.ensuring(checkout?.cleanup ?? Effect.void));
    return {
      output: [
        `Created ${name}/: ${result.done.join(", ")}.`,
        ...result.notes.map((note) => `note: ${note}`),
        "",
        nextStep(name, WORKFLOW_URL),
      ].join("\n"),
      code: 0,
    };
  });

/** Today in local time, `YYYY-MM-DD`: the date a new handoff's State carries. */
const today = (): string => {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

/**
 * `track pr [--title <title>] [--body-file <path>]`, and `track pr --check-body`, which reads
 * a PR body on stdin and fails listing the required sections it lacks (CI's pr.yml).
 */
const trackPrCommand = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === "--check-body") {
      const problems = headingProblems(yield* Effect.promise(() => Bun.stdin.text()));
      return problems.length === 0
        ? { output: "the PR body has every required section", code: 0 }
        : { output: `mshape: ${problems.join("\nmshape: ")}`, code: 1 };
    }
    const value = (flag: string) => {
      const at = args.indexOf(flag);
      return at === -1 ? undefined : args[at + 1];
    };
    const switches = new Set(["--body-only", "--wait"]);
    const valued = args.filter((arg) => !switches.has(arg));
    const known = new Set(["--title", "--body-file"]);
    const pairs =
      valued.length % 2 === 0 && valued.every((arg, i) => i % 2 === 1 || known.has(arg));
    if (!pairs) return usage();
    const title = value("--title");
    const bodyFile = value("--body-file");
    const body =
      bodyFile === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => Bun.file(bodyFile).text(),
            catch: (cause) =>
              new WorkspaceError({ operation: "read", path: bodyFile, reason: String(cause) }),
          });
    const output = yield* trackPr(
      root,
      {
        title,
        body,
        fetchEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        configDir: configDir(),
        harnesses: harnesses(process.env),
        bodyOnly: args.includes("--body-only"),
        ...(args.includes("--wait") ? { wait: CI_TIMING } : {}),
        notify: (to, subject, text) =>
          Effect.gen(function* () {
            const message = yield* mailSend(root, to, subject, text, new Date(), randomHex);
            const delivery = yield* notifyRecipient(
              root,
              message,
              harnesses(process.env),
              new Date(),
            ).pipe(
              Effect.catchTags({
                TrackError: (error) =>
                  Effect.succeed({ notified: 0, pruned: [], skipped: [error.reason] }),
                WorkspaceError: (error) =>
                  Effect.succeed({ notified: 0, pruned: [], skipped: [error.message] }),
              }),
            );
            return `${formatSent(message)}\n${formatDelivery(to, delivery)}`;
          }),
      },
      (line) => Effect.sync(() => console.error(line)),
    );
    return { output, code: 0 };
  });

const track = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "pr") return yield* trackPrCommand(root, rest);
    const flags = rest.filter((arg) => arg.startsWith("--"));
    const names = rest.filter((arg) => !arg.startsWith("--"));
    const allowed = sub === "rm" ? ["--force", "--keep-handoff", "--keep-beads"] : [];
    const takesName = sub === "new" || sub === "rm" || sub === "enter";
    if (flags.some((flag) => !allowed.includes(flag))) return usage();
    if (names.length !== (takesName ? 1 : 0)) return usage();
    const name = names[0] ?? "";
    if (sub === "new")
      return {
        output: yield* trackNew(
          root,
          name,
          today(),
          { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          new Date(),
        ),
        code: 0,
      };
    if (sub === "list") return { output: yield* trackList(root), code: 0 };
    if (sub === "migrate") {
      // The deliberate step: a handoff left in the older format fails it, so a script stops.
      const { output, unmigrated } = yield* trackMigrate(root, carryMessages(root));
      return { output, code: unmigrated === 0 ? 0 : 1 };
    }
    if (sub === "current") {
      // The name alone on stdout, which skills read; another branch is said on stderr.
      const found = yield* currentTrackOf(root);
      if (found.offBranch !== undefined)
        console.error(
          `note: ${found.offBranch}. Mail and \`track pr\` follow the worktree; \`track pr\` gates and pushes \`track/${found.track}\`'s tip, not this branch`,
        );
      return { output: found.track, code: 0 };
    }
    if (sub === "enter")
      return { output: (yield* enterTrack(root, caller(), name)).join("\n"), code: 0 };
    if (sub === "rm")
      return {
        output: yield* trackRm(
          root,
          name,
          {
            force: flags.includes("--force"),
            keepHandoff: flags.includes("--keep-handoff"),
            keepBeads: flags.includes("--keep-beads"),
            // rm fetches main's upstream; with no terminal to answer, a prompt would hang it.
            fetchEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
            sessions: trackSessions(root),
          },
          (line) => Effect.sync(() => console.error(line)),
        ),
        code: 0,
      };
    return usage();
  });

/** `track rm`'s view of the session registry; a failure is a reason, which rm reports. */
const trackSessions = (root: string): TrackSessions => {
  const reason = <A>(
    effect: Effect.Effect<A, TrackError | WorkspaceError>,
  ): Effect.Effect<A | { readonly unknown: string }> =>
    effect.pipe(
      Effect.catchTags({
        TrackError: (error) => Effect.succeed({ unknown: error.reason }),
        WorkspaceError: (error) => Effect.succeed({ unknown: error.message }),
      }),
    );
  return {
    live: (track) =>
      reason(
        Effect.map(liveSessions(root, track, harnesses(process.env), new Date()), (live) => ({
          live,
        })),
      ),
    remove: (track) => reason(removeSessions(root, track)),
  };
};

/**
 * A retired handoff Messages section, mailed to its track from the main checkout (so from
 * `main`) by `track migrate`. No live notice: it shows at the track's next prompt.
 */
const carryMessages =
  (root: string): CarryMessages =>
  (track, body) =>
    Effect.gen(function* () {
      const { repo } = yield* locate(root);
      const message = yield* mailSend(
        repo,
        track,
        "Messages carried over from your handoff",
        `${body}\n\nMoved here by \`mshape track migrate\` when handoffs stopped having a Messages section.`,
        new Date(),
        randomHex,
      );
      return { id: message.id };
    }).pipe(
      Effect.catchTags({
        TrackError: (error) => Effect.succeed({ reason: error.reason }),
        WorkspaceError: (error) => Effect.succeed({ reason: error.message }),
      }),
    );

/** Four hex digits for a message id: unique within a second among a handful of senders. */
const randomHex = (): string =>
  [...crypto.getRandomValues(new Uint8Array(2))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

/** `msg send`'s flags that take a value. */
const SEND_VALUES = ["--subject", "--body-file"] as const;

/**
 * `send <track>|--all --subject <subject> [body | --body-file <path>]`. Everything after `--`
 * is positional, so a body about a flag (`--force does ...`) can be sent; without it, such a
 * body is refused with the reason rather than the whole help. `--body-file` reads the body
 * from a file, so no shell quoting stands between the writer and the text. `--all` sends to
 * every track but the sender's own.
 */
const msgSend = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const end = args.indexOf("--");
    const options = end === -1 ? args : args.slice(0, end);
    const values = new Map<string, string | undefined>();
    const before: Array<string> = [];
    let all = false;
    for (let i = 0; i < options.length; i++) {
      const arg = options[i] ?? "";
      if ((SEND_VALUES as ReadonlyArray<string>).includes(arg)) values.set(arg, options[++i]);
      else if (arg === "--all") all = true;
      else before.push(arg);
    }
    const stray = before.find((arg) => arg.startsWith("--"));
    if (stray !== undefined)
      return {
        output: `mshape msg send: \`${stray}\` is read as a flag; to send text that starts with --, put -- before it: \`mshape msg send <track> --subject <subject> -- <body>\``,
        code: 2,
      };
    const positional = [...before, ...(end === -1 ? [] : args.slice(end + 1))];
    const subject = values.get("--subject");
    const bodyFile = values.get("--body-file");
    const wanted = (all ? 0 : 1) + (values.has("--body-file") ? 0 : 1);
    if (
      subject === undefined ||
      (values.has("--body-file") && bodyFile === undefined) ||
      positional.length > wanted ||
      positional.length < (all ? 0 : 1)
    )
      return usage();
    // A recipient left beside --all would otherwise go to every track as the body.
    const lone = all && before.length === 1 ? before[0] : undefined;
    if (lone !== undefined && (yield* isAddress(root, lone)))
      return {
        output: `mshape msg send: \`${lone}\` reads as a recipient, and --all sends to every track. Drop --all to send to ${lone} alone, or drop \`${lone}\`; to send it as the body, put -- before it`,
        code: 2,
      };
    const [to = "", inline = ""] = all ? ["", ...positional] : positional;
    const body =
      bodyFile === undefined
        ? inline
        : yield* Effect.tryPromise({
            try: () => readFile(resolve(root, bodyFile), "utf8"),
            catch: () => new TrackError({ reason: `--body-file ${bodyFile}: can't read it` }),
          });
    const recipients = all ? yield* everyTrackBut(root, caller()) : [to];
    const said: Array<string> = [];
    for (const recipient of recipients) {
      const message = yield* mailSend(
        root,
        recipient,
        subject,
        body,
        new Date(),
        randomHex,
        caller(),
      );
      // Stored first: whatever happens to the notices, the mail waits for them.
      const delivery = yield* notifyRecipient(
        root,
        message,
        harnesses(process.env),
        new Date(),
      ).pipe(
        Effect.catchTags({
          TrackError: (error) =>
            Effect.succeed({ notified: 0, pruned: [], skipped: [error.reason] }),
          WorkspaceError: (error) =>
            Effect.succeed({ notified: 0, pruned: [], skipped: [error.message] }),
        }),
      );
      said.push(formatSent(message), formatDelivery(recipient, delivery));
    }
    return { output: said.join("\n"), code: 0 };
  });

/** Pushes a stored message's notice to the sessions at its address; a failure changes nothing. */
const pushNotice = (root: string, message: Message) =>
  notifyRecipient(root, message, harnesses(process.env), new Date());

/**
 * Turns the repo's watches into mail before an inbox is listed, so a watch's own message shows
 * in it. Never fails the inbox: what went wrong is a note.
 */
const watchNotes = (root: string) =>
  checkWatches(root, new Date(), ghObserver(process.env), randomHex, (message) =>
    pushNotice(root, message),
  ).pipe(
    Effect.map((checked) => checked.notes),
    Effect.catchTags({
      TrackError: (error) => Effect.succeed([`note: mshape msg watch: ${error.reason}`]),
      WorkspaceError: (error) => Effect.succeed([`note: mshape msg watch: ${error.message}`]),
    }),
  );

/** Whether `word` names an address a message can go to: a track, `main` or a review. */
const isAddress = (root: string, word: string) =>
  Effect.gen(function* () {
    if (word === "main" || isReviewAddress(word)) return true;
    const { repo } = yield* locate(root);
    return (yield* trackNames(repo)).includes(word);
  });

/** `--all`'s recipients: every track, less the sender's own address. Refuses when none is left. */
const everyTrackBut = (root: string, who: Caller) =>
  Effect.gen(function* () {
    const { repo } = yield* locate(root);
    const { address } = yield* sessionAddress(root, who).pipe(
      Effect.orElseSucceed(() => ({ address: "" })),
    );
    const tracks = (yield* trackNames(repo)).filter((track) => track !== address);
    if (tracks.length === 0)
      return yield* Effect.fail(
        new TrackError({ reason: "msg send --all: there is no track to send to" }),
      );
    return tracks;
  });

/**
 * `--quiet` is the hooks' form: nothing when there's nothing to read or this has no address,
 * and never a failure, since a hook that fails would interrupt the session it serves. A
 * mailbox that can't be read is still said, as a note, and so is a session that isn't
 * registered, at every prompt, until it is.
 */
const msgInbox = (root: string, quiet: boolean) =>
  Effect.gen(function* () {
    const who = quiet ? yield* Effect.promise(hookCaller) : caller();
    return yield* inboxFor(root, who, quiet);
  });

/**
 * The inbox's lines for `who`, after the repo's watches have become mail; `quiet`, the hooks'
 * form, as `msgInbox` says.
 */
const inboxFor = (root: string, who: Caller, quiet: boolean) =>
  Effect.gen(function* () {
    const watched = yield* watchNotes(root);
    const inbox = yield* mailInbox(root, who);
    const listed = formatInbox(inbox.address, inbox.messages, inbox.unreadable, quiet);
    const note =
      inbox.unregistered === undefined
        ? []
        : [unregisteredNote(inbox.unregistered.session, inbox.address)];
    return {
      output: [...(listed === "" ? [] : [listed]), ...note, ...watched].join("\n"),
      code: 0,
    };
  }).pipe(
    Effect.catchTags({
      TrackError: (error) => (quiet ? Effect.succeed({ output: "", code: 0 }) : Effect.fail(error)),
      WorkspaceError: (error) =>
        quiet
          ? Effect.succeed({ output: `note: mshape msg inbox: ${error.message}`, code: 0 })
          : Effect.fail(error),
    }),
  );

/** This machine's config directory, which holds its denylist: XDG's, else `~/.config`. */
const configDir = (): string => {
  const xdg = process.env["XDG_CONFIG_HOME"] ?? "";
  return xdg.startsWith("/") ? xdg : `${homedir()}/.config`;
};

/** `scan <file>`, or `scan -` for stdin: the denylisted terms in it, exit 1 on any. */
const scan = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [file] = args;
    if (args.length !== 1 || file === undefined) return usage();
    const text = yield* Effect.tryPromise({
      try: () => (file === "-" ? Bun.stdin.text() : Bun.file(file).text()),
      catch: (cause) =>
        new WorkspaceError({ operation: "read", path: file, reason: String(cause) }),
    });
    return yield* scanFile(root, configDir(), file === "-" ? "stdin" : file, text);
  });

/**
 * `mshape prime`: what a session loads at its start, in any harness, hooked or run by the
 * agent: PRIME, then this session's registration (silent when done or outside every address,
 * a note otherwise), then its unread subjects. Never fails: each part that can't run is a note.
 */
const prime = (root: string) =>
  Effect.gen(function* () {
    const who = yield* Effect.promise(hookCaller);
    const loop = yield* primeText(root);
    const registered = yield* register(root, who);
    const inbox = yield* inboxFor(root, who, true).pipe(
      Effect.catchTags({
        TrackError: () => Effect.succeed({ output: "", code: 0 }),
        WorkspaceError: (error) =>
          Effect.succeed({ output: `note: mshape prime: ${error.message}`, code: 0 }),
      }),
    );
    const parts = [loop.text, loop.note, registered, inbox.output];
    return {
      output: parts
        .filter((part): part is string => part !== undefined && part !== "")
        .join("\n\n"),
      code: 0,
    };
  });

/** The SessionStart hook's form: silent when done or outside every address, a note otherwise. */
const msgRegister = (root: string) =>
  Effect.gen(function* () {
    const note = yield* register(root, yield* Effect.promise(hookCaller));
    return { output: note ?? "", code: 0 };
  });

const msg = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "send") return yield* msgSend(root, rest);
    if (sub === "inbox" && rest.length === 0) return yield* msgInbox(root, false);
    if (sub === "inbox" && rest.length === 1 && rest[0] === "--quiet")
      return yield* msgInbox(root, true);
    if (sub === "inbox" && rest.length === 1 && rest[0] === "--all")
      return { output: formatAllInboxes(yield* mailInboxAll(root)), code: 0 };
    if (sub === "register" && rest.length === 0) return yield* msgRegister(root);
    if (sub === "watch" && rest.length === 0)
      return { output: yield* watchList(root, caller()), code: 0 };
    if (sub === "watch")
      return {
        output: yield* watchAdd(root, rest, caller(), ghObserver(process.env), new Date()),
        code: 0,
      };
    if (sub === "unwatch") return { output: yield* watchRemove(root, rest, caller()), code: 0 };
    if (sub === "read" && rest.length === 1) {
      const { message, alreadyRead } = yield* mailRead(root, rest[0] ?? "", caller());
      return { output: formatMessage(message, alreadyRead), code: 0 };
    }
    return usage();
  });

const review = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] !== "rm")
      return {
        output: yield* reviewNew(
          root,
          args[0] ?? "",
          (line) => Effect.sync(() => console.error(line)),
          caller(),
        ),
        code: 0,
      };
    if (args.length === 3 && args[0] === "post")
      return {
        output: yield* reviewPost(root, configDir(), args[1] ?? "", args[2] ?? "", (line) =>
          Effect.sync(() => console.error(line)),
        ),
        code: 0,
      };
    if (args.length === 2 && args[0] === "rm")
      return {
        output: yield* reviewRm(root, args[1] ?? "", (line) =>
          Effect.sync(() => console.error(line)),
        ),
        code: 0,
      };
    return usage();
  });

/**
 * `--replace <path>` arguments, split into ownable files and skill names; a string is the
 * reason they can't be.
 */
const replaceArgs = (
  args: ReadonlyArray<string>,
): { files: Array<string>; skills: Array<string> } | string => {
  const files: Array<string> = [];
  const skills: Array<string> = [];
  for (let i = 0; i < args.length; i += 2) {
    const path = args[i + 1]?.replace(/^\.\//, "").replace(/\/+$/, "");
    if (args[i] !== "--replace" || path === undefined) return help();
    const skill = path.startsWith(`${SKILLS_DIR}/`) ? path.slice(SKILLS_DIR.length + 1) : "";
    if (OWNABLE_FILES.includes(path)) files.push(path);
    else if (SKILL_NAME.test(skill)) skills.push(skill);
    else
      return `mshape: sync --replace takes ${OWNABLE_FILES.join(", ")} or ${SKILLS_DIR}/<skill>, not ${path}`;
  }
  return { files, skills };
};

const sync = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const replace = replaceArgs(args);
    if (typeof replace === "string") return { output: replace, code: 2 };
    const {
      plan,
      skills: { sync: skillSync, linked },
    } = yield* syncAll(root, PACKAGE_ROOT, replace);
    const files = formatSyncPlan(plan);
    return {
      output: [
        formatSync(skillSync),
        ...(linked ? [`${CLAUDE_SKILLS_LINK}: linked`] : []),
        ...(files.length === 0 ? ["PRIME.md, PR template, hooks: up to date"] : files),
        ...formatCollisions(skillSync),
      ].join("\n"),
      code: skillSync.collisions.length > 0 || plan.blocked.length > 0 ? 1 : 0,
    };
  });

/** `mshape skills sync`, from before sync covered more than skills: the same command. */
const skills = (root: string, args: ReadonlyArray<string>) =>
  args.length === 1 && args[0] === "sync" ? sync(root, []) : Effect.succeed(usage());

/** What `check`, `baseline` and `garden` all read: the config, the snapshot, the baseline. */
/** `--config <path>`, resolved from the repo root, or undefined for the repo's own config. */
const configFlag = (root: string, args: ReadonlyArray<string>): string | undefined => {
  const at = args.indexOf("--config");
  const path = at === -1 ? undefined : args[at + 1];
  return path === undefined ? undefined : resolve(root, path);
};

/** Where fetched tools are kept: the machine's cache, as the environment places it. */
const toolCache = (): string =>
  cacheRoot({ XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"], HOME: process.env["HOME"] }, tmpdir());

/** `checks`: what the caller will run, so the loader skips tools nothing will read. */
const load = (root: string, args: ReadonlyArray<string>, checks: ReadonlyArray<CheckName>) =>
  Effect.gen(function* () {
    const config = yield* loadConfig(root, configFlag(root, args));
    const loaded = yield* Effect.flatMap(
      loadSnapshot(root, config, PACKAGE_ROOT, { checks, cache: toolCache() }),
      (snapshot) => withBeadsExport(root, snapshot),
    );
    const baseline = yield* readBaseline(root);
    // Only a baseline needs to know which occurrence is new.
    const snapshot =
      Object.keys(baseline).length === 0
        ? loaded
        : { ...loaded, changedLines: yield* readChangedLines(root) };
    return { config, snapshot, baseline };
  });

/** `mshape dep bump <name> <tarball> --sha256 <digest>`. */
const dep = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const at = args.indexOf("--sha256");
    const digest = at === -1 ? undefined : args[at + 1];
    const rest = args.filter((_, i) => at === -1 || (i !== at && i !== at + 1));
    const [sub, name, tarball, ...extra] = rest;
    if (
      sub !== "bump" ||
      name === undefined ||
      tarball === undefined ||
      extra.length > 0 ||
      digest === undefined ||
      digest.startsWith("--")
    )
      return {
        output:
          "mshape dep bump: give the package, the tarball and the digest its release states: `mshape dep bump <name> <tarball> --sha256 <digest>`",
        code: 2,
      };
    const config = yield* loadConfig(root);
    const result = yield* depBump(
      root,
      config.configFile,
      config.files.vendored,
      name,
      resolve(root, tarball),
      digest,
    );
    return { output: result.lines.join("\n"), code: result.code };
  });

const check = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // Before loading: an unknown check is a usage error, and the selection decides what runs.
    const only = parseOnly(args);
    if (typeof only === "string") return { output: only, code: 2 };
    const { config, snapshot, baseline } = yield* load(root, args, only);
    const result = assess(config, snapshot, baseline, only);
    return { output: formatCheck(result), code: result.green ? 0 : 1 };
  });

/** `mshape gate [--fast]`: the repo's gate from its config, `mshape check` among its stages. */
const gate = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fast = args.includes("--fast");
    const rest = args.filter((arg) => arg !== "--fast");
    const flagged = configFlag(root, rest);
    if (rest.length !== (flagged === undefined ? 0 : 2)) return usage();
    const config = yield* loadConfig(root, flagged);
    return yield* runGate(root, config, {
      fast,
      check: check(root, flagged === undefined ? [] : ["--config", flagged]),
    });
  });

const baseline = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // A baseline counts every check, so everything runs.
    const loaded = yield* load(root, args, CHECKS);
    const { config, snapshot } = loaded;
    const blocked = prerequisites(config, snapshot);
    // A baseline written without a required integration would grandfather an incomplete count.
    if (blocked.length > 0)
      return {
        output: [
          ...blocked.map(formatViolation),
          "mshape baseline: not written, because a prerequisite fails",
        ].join("\n\n"),
        code: 1,
      };
    const { violations, unevaluated: skipped } = evaluate(
      config,
      snapshot,
      CHECKS,
      Object.keys(loaded.baseline),
    );
    if (args.includes("--init")) {
      yield* writeBaseline(root, initBaseline(loaded.baseline, violations, skipped));
      const kept = [...skipped].filter((rule) => loaded.baseline[rule] !== undefined).sort();
      return {
        output: [
          `${BASELINE_FILE}: grandfathered ${violations.length} violation(s)`,
          ...tallyByRule(violations.map((v) => v.rule)),
          ...(kept.length > 0
            ? [`kept as they were, since this checkout couldn't evaluate them: ${kept.join(", ")}`]
            : []),
        ].join("\n"),
        code: 0,
      };
    }
    if (args.includes("--tighten")) {
      yield* writeBaseline(root, tighten(loaded.baseline, violations, skipped));
      return { output: `${BASELINE_FILE}: tightened`, code: 0 };
    }
    return usage();
  });

const gardenCommand = (root: string, args: ReadonlyArray<string>) =>
  // Garden reads no tool's or command's results: none of them run.
  Effect.map(load(root, args, []), ({ config, snapshot, baseline }) => ({
    output: formatGarden(garden(config, snapshot, baseline)),
    code: 0,
  }));

/**
 * Works before adopting: with no ./shape.toml, the registry's rules alone. A `--config`
 * that can't load is an error, as for `check`, so a typo can't read as "no local rules".
 */
const rules = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // Loaded for its errors only: the repo's own rules are shape-rules/'s files.
    const path = configFlag(root, args) ?? (yield* findConfig(root));
    if (path !== undefined) yield* loadConfig(root, path);
    const shape = yield* listShapeRules(root);
    return { output: formatRules(RULES, shape), code: 0 };
  });

/**
 * `mshape config schema`: the JSON Schema of `shape.toml`, as the package ships it.
 * `mshape config migrate`: `shape.config.ts` to `shape.toml`, pinning the running package.
 */
const configCommand = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] === "schema")
      return { output: shapeJsonSchema().trimEnd(), code: 0 };
    if (args.length !== 1 || args[0] !== "migrate") return usage();
    // It imports the TypeScript config, so it runs under the npm package, whose version the
    // repo's node_modules holds: that is the pin (sync/pin-npm-differs).
    const result = yield* migrateConfig(root, {
      version: (yield* checkoutVersion()) ?? pkg.version,
    });
    return { output: result.lines.join("\n"), code: result.code };
  });

/** Every command, in the order the help lists them. */
export const COMMANDS: ReadonlyArray<Command> = [
  {
    name: "init",
    usage: `  mshape init <name> [--pack <pack>] [--from <spec>]
      Create ./<name>: a new repo whose gate passes, with one starter test. --pack is its
      language (typescript by default). --from installs monkeyshape from <spec> (a tarball
      path) instead of the registry, to try a release first.`,
    run: init,
  },
  {
    name: "sync",
    usage: `  mshape sync [--replace <path>]...
      After a bump, bring what the installed package ships up to date: the shared skills in
      .agents/skills, .beads/PRIME.md, the PR template, and monkeyshape's hooks in
      .claude/settings.json. Skills and hooks the package doesn't ship are left alone, and so
      is a PRIME.md, PR template or skill this repo wrote itself: --replace <path> replaces it
      with the shipped one, and sync keeps it up to date from then on.`,
    run: sync,
  },
  {
    name: "skills",
    usage: `  mshape skills sync
      The same as mshape sync.`,
    run: skills,
  },
  {
    name: "check",
    usage: `  mshape check [--only ${CHECKS.join(",")}]
      Run the checks; violations above .shape/baseline.json fail.`,
    run: check,
  },
  {
    name: "gate",
    usage: `  mshape gate [--fast]
      Run the repo's gate: each pack's default stages, mshape check, then shape.toml's
      [gate].stages. Fast stages first; --fast runs only those (track pr does). A failing
      stage doesn't stop the rest; its output's tail is shown and the whole kept in a log.`,
    run: gate,
  },
  {
    name: "baseline",
    usage: `  mshape baseline --tighten
      Lower baseline counts to what is found now. Never raises one.
  mshape baseline --init
      Grandfather every current violation. For adopting a repo; review the diff.`,
    run: baseline,
  },
  {
    name: "garden",
    usage: `  mshape garden
      Print budgets and escape hatches for the milestone-boundary sweep.`,
    run: gardenCommand,
  },
  {
    name: "rules",
    usage: `  mshape rules [--config <path>]
      List the custom rules, the repo's own (localRules) included, and the bug class each removes.`,
    run: rules,
  },
  {
    name: "config",
    usage: `  mshape config schema
      Print the JSON Schema of shape.toml, which the package ships as schema/shape.schema.json:
      point an editor's TOML support at it to validate the config as you type.
  mshape config migrate
      Once, in a repo with shape.config.ts: write shape.toml with the same values (packs =
      ["typescript"], pinning this mshape) and delete shape.config.ts. Refuses while a local rule
      isn't ported to shape-rules/, and where shape.toml is already here.`,
    run: configCommand,
  },
  {
    name: "track",
    usage: `  mshape track new <name>
      Start a track: worktree .agents/worktrees/<repo>@<name> on track/<name> from main (or
      from main's upstream, after fetching it, when that has commits main lacks),
      the shared handoffs and tracks.shared-paths linked in, and a stub handoff. Shared paths
      come from the main checkout's config (shape.toml), from whichever checkout this runs.
  mshape track list
      Every track: handoff status, open beads, commits in neither main nor origin/main,
      whether it is done, worktree. Done is yes only with no open bead, the branch merged and
      no open PR (from gh); unknown when bd or gh can't say. Under a row: beads still open
      though a merged PR lists them, a State older than the branch's last commit, and a done
      track's rm. Restores missing handoff links; a track label with open beads and no track
      left is listed too. Run git fetch to see merges done on the remote. It never rewrites a
      handoff: one in an older format is noted, with what track migrate would change.
  mshape track migrate
      Upgrade every handoff in an older format in place, printing what changed in each; a
      retired Messages section is mailed to its track first. Exit 1 when a handoff had to be
      left as it was, saying why.
  mshape track current
      The track of this directory, name only; exit 1, saying why, outside a track.
  mshape track enter <name>
      Move this Claude Code session to track <name>, from main or any other address: its
      mail and notices become the track's (unread mail stays where it was), and the last line
      printed is the track's worktree, where the session then works. Refuses an unknown track,
      or a session Claude Code didn't identify. A new session id (/clear, a fresh start)
      registers by its directory again.
  mshape track pr [--title <title>] [--body-file <path>] [--body-only] [--wait]
      From a track's worktree, whatever branch it has checked out: prints the PR's size
      against the batching default, runs \`mshape gate --fast\` on a clean checkout of
      track/<name>'s tip, pushes that tip and opens its PR (--title and --body-file needed)
      or updates it. CI runs the whole gate; where no pull_request workflow runs it, the
      whole gate runs here. Writes only the Gate section, from
      that run and CI; the rest of the body is --body-file's, or the PR's as it stands. Refuses, posting nothing: while a review of the PR is in progress (a
      live reviewer at review-<track> with this PR's review worktree, or at review-<n>, and no
      review on the PR's head yet) and the push would move its head, on uncommitted changes to track/<name>, a denylisted term
      in what it would send (see scan: the commits the remote lacks, their messages, added
      lines and paths, the title and body), a failing gate (naming its failing tests; the
      gate's output and each stage's log are kept under .git/monkeyshape/gate/), a missing required section or a
      bead bd doesn't know. Warns when the tip is behind main,
      naming the files a merge would conflict in. --body-only edits the body (and title)
      with no push and no gate, keeping the Gate section; refused unless that section ran on
      the tip and the tip is the PR's head. --wait then waits for CI on the commit, writes
      its result in the Gate section, and exits 1 when a check fails.
  mshape track pr --check-body
      Read a PR body on stdin; exit 1 naming the required sections it lacks (CI's pr.yml).
      track pr also needs each bead as a list item starting with its id, to check it with bd.
  mshape track rm <name> [--force] [--keep-handoff] [--keep-beads]
      Remove a finished track: worktree, branch, handoff, mailbox. Fetches main's upstream
      first, then refuses on uncommitted changes, work in neither main nor origin/main (by
      merge, rebase or squash), or unread mail; --force discards them. Also refuses while beads
      labelled track:<name> aren't closed, which --force doesn't override; --keep-beads leaves
      them labelled for a new track of the same name you start next (a milestone reusing it),
      and refuses unless the track is otherwise done: merged, no open PR, one merged (from gh).
      --keep-handoff keeps the handoff and mailbox, for a track that continues. Never touches
      main or other tracks.`,
    run: track,
  },
  {
    name: "dep",
    usage: `  mshape dep bump <name> <tarball> --sha256 <digest>
      Move the vendored dependency <name> (recorded in the config's files.vendored) to
      <tarball>, a release of it on disk. <digest> is the sha256 its release states, never one
      computed here: a tarball that doesn't match it, or is another package, changes nothing.
      Copies it into vendor/, removes the old one, updates package.json, the record and
      bun.lock, then runs the gate. Never fetches.`,
    run: dep,
  },
  {
    name: "review",
    usage: `  mshape review <n>
      Pull request <n>'s head from origin in a detached worktree .agents/worktrees/<repo>.pr-<n>,
      tracks.shared-paths and the shared handoffs (.handoffs) linked in. Again later: put it
      exactly at the new head, printing the old one; edits to tracked files there are listed,
      then discarded.
      A session at main (or at another review) moves to the reviewer's address, so its mail
      is the review's; a session at a track stays there. The address is review-<track> when
      the PR's head is a track's branch on origin (track/<track>), held across that track's
      PRs and between them, while the track exists; otherwise review-<n>.
  mshape review rm <n>
      Remove that worktree and its fetched ref. A reviewer at review-<track> keeps that
      address and its mail for the track's next PR; for a PR from no track, review-<n>'s
      unread mail is listed and its sessions removed. Never the shared data or the handoffs.
  mshape review post <n> <file>
      Post <file>, a review as GitHub's reviews API takes it ({commit_id, event, body,
      comments}), on pull request <n>, after scanning every string in it for denylisted terms
      (see scan): a match refuses, naming where, and nothing is posted.`,
    run: review,
  },
  {
    name: "scan",
    usage: `  mshape scan <file>
      Print each denylisted term in <file> (- for stdin) with its line and column; exit 1 on
      any. The lists, one term per line matched case-insensitively, are never in a repo:
      ~/.config/monkeyshape/denylist (or under $XDG_CONFIG_HOME) for the machine, and
      <git common dir>/monkeyshape/denylist for the clone. track pr scans what its push adds
      and the PR's title and body the same way, refusing before it pushes.`,
    run: scan,
  },
  {
    name: "msg",
    usage: `  mshape msg send <track> --subject <subject> [body | --body-file <path>]
      Leave a message in the mailbox of <track>, main or a reviewer (review-<track>, or
      review-<n> for a PR from no track), from this session's address, then push its subject
      to the sessions registered there. The subject is one
      line; it is all a notice shows. --body-file reads the body from a file, with no shell
      quoting to get wrong; else quote the body, and put -- before one that starts with --.
  mshape msg send --all --subject <subject> [body | --body-file <path>]
      The same message to every track but this session's own, one mailbox each.
  mshape msg inbox [--quiet]
      Unread messages at this session's address, oldest first. --quiet, for hooks: nothing
      when there are none or there is no address, and never a failure.
  mshape msg inbox --all
      Every address's unread mail, from any checkout, and mail left at one that is gone.
      For the milestone boundary; marks nothing read.
  mshape msg read <id>
      Print a message and mark it read at this address. Nothing else marks one read.
  mshape msg watch pr <n> | bead <id> | ci <sha> | main
      Be told by mail, from mshape, when pull request <n> merges or closes, a bead closes,
      CI on a commit ends (pass or fail), or a head of main fails CI and later passes again.
      A pr, bead or ci watch is removed once it fires; main's stays. Each event is sent
      once. Checked through gh and bd when any session's inbox is read, at most once a
      minute; a gh or bd that can't run is a note, and no watch is lost.
  mshape msg watch
      This address's watches.
  mshape msg unwatch pr <n> | bead <id> | ci <sha> | main
      Stop one; a ci watch matches the start of its commit id.
  mshape msg register
      Record this session at its checkout's address (a track, main, review-<track>, or
      review-<n> for a PR from no track), or where it already is, so send notifies it at
      once. mshape prime does this too. Silent outside every address; never fails.`,
    run: msg,
  },
  {
    name: "prime",
    usage: `  mshape prime
      What a session loads at its start: the loop (bd prime, else .beads/PRIME.md), this
      session's registration, and its unread mail. The session-start hook runs it; where a
      harness has none, the agent runs it. Never fails; never waits on a terminal.
  mshape --harness <id> <command>
      Any command, as run by a hook of harness <id>: only that harness identifies the
      session (${HARNESS_IDS.join(", ")}).`,
    run: (root, args) => (args.length === 0 ? prime(root) : Effect.succeed(usage())),
  },
];

const HELP: ReadonlyArray<string | undefined> = [undefined, "help", "--help"];

export const program = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    // A hook's `--harness <id>`, first and only first, so no argument is ever read as one.
    const flagged = args[0] === "--harness";
    const named = flagged ? args[1] : undefined;
    const invokedBy = HARNESS_IDS.find((id) => id === named);
    setInvokedBy(invokedBy);
    if (flagged && invokedBy === undefined)
      return {
        output: `mshape: --harness takes one of ${HARNESS_IDS.join(", ")}${named === undefined ? "" : `, not \`${named}\``}`,
        code: 2,
      };
    const [name, ...rest] = flagged ? args.slice(2) : args;
    if (name === "--version") return { output: pkg.version, code: 0 };
    if (HELP.includes(name)) return { output: help(), code: 0 };
    const command = COMMANDS.find((entry) => entry.name === name);
    if (command === undefined)
      return { output: `mshape: unknown command '${name}'\n\n${help()}`, code: 2 };
    return yield* command.run(root, rest);
  });

/** Runs the command `process.argv` names and sets the exit code. */
export const runMain = async (): Promise<void> => {
  const outcome = await Effect.runPromise(
    program(process.cwd(), process.argv.slice(2)).pipe(
      Effect.catchTags({
        ConfigError: (error) => Effect.succeed({ output: `mshape: ${error.message}`, code: 2 }),
        WorkspaceError: (error) => Effect.succeed({ output: `mshape: ${error.message}`, code: 2 }),
        TrackError: (error) => Effect.succeed({ output: `mshape: ${error.message}`, code: 1 }),
      }),
    ),
  );
  // An empty output prints nothing: a quiet hook adds not even a blank line to the session.
  if (outcome.code === 0) {
    if (outcome.output !== "") console.log(outcome.output);
  } else console.error(outcome.output);
  process.exitCode = outcome.code;
};

// Only as the executable: tests import the table and the help without running a command.
if (import.meta.main) await runMain();
