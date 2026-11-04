#!/usr/bin/env bun
/** The `mshape` executable: the composition root, and the only place effects are run. */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import pkg from "../../package.json" with { type: "json" };
import { BASELINE_FILE, readBaseline, writeBaseline } from "../adapters/baseline.ts";
import { loadConfig } from "../adapters/config.ts";
import { initRepo, vendoredSpec } from "../adapters/init.ts";
import { mailInbox, mailInboxAll, mailRead, mailSend } from "../adapters/mail.ts";
import {
  type Caller,
  claudeCodeNotifier,
  liveSessions,
  notifyRecipient,
  register,
  removeSessions,
} from "../adapters/notices.ts";
import { reviewNew, reviewRm } from "../adapters/reviews.ts";
import { installSkills } from "../adapters/skills.ts";
import { syncRepo } from "../adapters/sync.ts";
import { trackPr } from "../adapters/trackPr.ts";
import {
  type CarryMessages,
  locate,
  type TrackSessions,
  trackCurrent,
  trackList,
  trackMigrate,
  trackNew,
  trackRm,
} from "../adapters/tracks.ts";
import { loadSnapshot } from "../adapters/workspace.ts";
import { assess, CHECKS, prerequisites, runChecks, unevaluated } from "../core/check.ts";
import { garden } from "../core/garden.ts";
import { CLAUDE_SKILLS_LINK } from "../core/layout.ts";
import { formatAllInboxes, formatInbox, formatMessage, formatSent } from "../core/mail.ts";
import type { CheckName } from "../core/model.ts";
import { formatDelivery, unregisteredNote } from "../core/notices.ts";
import { count, tighten } from "../core/ratchet.ts";
import { formatCheck, formatGarden, formatViolation } from "../core/report.ts";
import { RULES } from "../core/rules/registry.ts";
import { nextStep, REPO_NAME } from "../core/scaffold.ts";
import { formatCollisions, formatSync } from "../core/skills.ts";
import { formatSyncPlan } from "../core/sync.ts";
import { headingProblems } from "../core/trackPr.ts";
import { type ConfigError, type TrackError, WorkspaceError } from "../schemas/errors.ts";

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

const FLAGS = `  --config <path>   For check, baseline and garden: use this config instead of ./shape.config.ts
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

/** The package's own directory: `template/` and `skills/` ship beside `src/`. */
const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

const WORKFLOW_URL = `${pkg.homepage.replace(/#.*$/, "")}/blob/main/docs/workflow.md`;

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
    const positional = args.filter(
      (_, i) => fromFlag === -1 || (i !== fromFlag && i !== fromFlag + 1),
    );
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
    const tarball =
      local !== undefined && (yield* Effect.promise(() => Bun.file(local).exists()))
        ? local
        : undefined;
    const spec =
      tarball !== undefined ? vendoredSpec(tarball) : local !== undefined ? `file:${local}` : from;
    const dev = pkg.devDependencies;
    const result = yield* initRepo(
      `${root}/${name}`,
      name,
      PACKAGE_ROOT,
      {
        bun: Bun.version,
        monkeyshape: spec ?? pkg.version,
        effect: dev.effect,
        biome: dev["@biomejs/biome"],
        typescript: dev.typescript,
        typesBun: dev["@types/bun"],
      },
      tarball,
    );
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
    const known = new Set(["--title", "--body-file"]);
    const pairs = args.length % 2 === 0 && args.every((arg, i) => i % 2 === 1 || known.has(arg));
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
      { title, body, fetchEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
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
    const takesName = sub === "new" || sub === "rm";
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
    if (sub === "migrate")
      return { output: yield* trackMigrate(root, carryMessages(root)), code: 0 };
    if (sub === "current") return { output: yield* trackCurrent(root), code: 0 };
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
      reason(Effect.map(liveSessions(root, track, claudeDir(), new Date()), (live) => ({ live }))),
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

/**
 * `send <track> --subject <subject> [body]`. Everything after `--` is positional, so a body
 * about a flag (`--force does ...`) can be sent; without it, such a body is refused with the
 * reason rather than the whole help.
 */
const msgSend = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const end = args.indexOf("--");
    const options = end === -1 ? args : args.slice(0, end);
    const flag = options.indexOf("--subject");
    const subject = flag === -1 ? undefined : options[flag + 1];
    const before = options.filter((_, i) => flag === -1 || (i !== flag && i !== flag + 1));
    const stray = before.find((arg) => arg.startsWith("--"));
    if (stray !== undefined)
      return {
        output: `mshape msg send: \`${stray}\` is read as a flag; to send text that starts with --, put -- before it: \`mshape msg send <track> --subject <subject> -- <body>\``,
        code: 2,
      };
    const positional = [...before, ...(end === -1 ? [] : args.slice(end + 1))];
    if (subject === undefined || positional.length < 1 || positional.length > 2) return usage();
    const [to = "", body = ""] = positional;
    const message = yield* mailSend(root, to, subject, body, new Date(), randomHex, caller());
    // Stored first: whatever happens to the notices, the mail waits for them.
    const delivery = yield* notifyRecipient(
      root,
      message,
      claudeCodeNotifier,
      claudeDir(),
      new Date(),
    ).pipe(
      Effect.catchTags({
        TrackError: (error) => Effect.succeed({ notified: 0, pruned: [], skipped: [error.reason] }),
        WorkspaceError: (error) =>
          Effect.succeed({ notified: 0, pruned: [], skipped: [error.message] }),
      }),
    );
    return { output: `${formatSent(message)}\n${formatDelivery(to, delivery)}`, code: 0 };
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
    const inbox = yield* mailInbox(root, who);
    const listed = formatInbox(inbox.address, inbox.messages, inbox.unreadable, quiet);
    const note =
      inbox.unregistered === undefined
        ? []
        : [
            unregisteredNote(
              inbox.unregistered.session,
              inbox.address,
              inbox.unregistered.registrable,
            ),
          ];
    return { output: [...(listed === "" ? [] : [listed]), ...note].join("\n"), code: 0 };
  }).pipe(
    Effect.catchTags({
      TrackError: (error) => (quiet ? Effect.succeed({ output: "", code: 0 }) : Effect.fail(error)),
      WorkspaceError: (error) =>
        quiet
          ? Effect.succeed({ output: `note: mshape msg inbox: ${error.message}`, code: 0 })
          : Effect.fail(error),
    }),
  );

/** Claude Code's config directory, where it records each session: `~/.claude` by default. */
const claudeDir = (): string => process.env["CLAUDE_CONFIG_DIR"] ?? `${homedir()}/.claude`;

/** The caller, as Claude Code's environment says; `session` overrides its session id. */
const caller = (session = process.env["CLAUDE_CODE_SESSION_ID"] ?? ""): Caller => {
  const pid = Number(process.env["CLAUDE_PID"] ?? "");
  return {
    identity: {
      ...(session === "" ? {} : { session }),
      ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    },
    claudeDir: claudeDir(),
    now: new Date(),
  };
};

/**
 * A hook's caller: the session id from the hook's JSON on stdin, else from Claude Code's
 * environment. Only hooks read stdin, and never from a terminal, so nothing waits on one.
 */
const hookCaller = async (): Promise<Caller> => {
  if (!process.stdin.isTTY) {
    const input = await Bun.stdin.text();
    const match = /"session_id"\s*:\s*"([^"]+)"/.exec(input);
    if (match?.[1] !== undefined) return caller(match[1]);
  }
  return caller();
};

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
    if (args.length === 2 && args[0] === "rm")
      return {
        output: yield* reviewRm(root, args[1] ?? "", (line) =>
          Effect.sync(() => console.error(line)),
        ),
        code: 0,
      };
    return usage();
  });

const sync = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length > 0) return usage();
    const { sync: skillSync, linked } = yield* installSkills(`${PACKAGE_ROOT}/skills`, root);
    const plan = yield* syncRepo(root, PACKAGE_ROOT);
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
const load = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const configFlag = args.indexOf("--config");
    const configPath = configFlag === -1 ? undefined : args[configFlag + 1];
    const config = yield* loadConfig(
      root,
      configPath === undefined
        ? undefined
        : configPath.startsWith("/")
          ? configPath
          : `${root}/${configPath}`,
    );
    const snapshot = yield* loadSnapshot(root, config, PACKAGE_ROOT);
    const baseline = yield* readBaseline(root);
    return { config, snapshot, baseline };
  });

const check = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { config, snapshot, baseline } = yield* load(root, args);
    const only = parseOnly(args);
    if (typeof only === "string") return { output: only, code: 2 };
    const result = assess(config, snapshot, baseline, only);
    return { output: formatCheck(result), code: result.green ? 0 : 1 };
  });

const baseline = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const loaded = yield* load(root, args);
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
    const violations = runChecks(config, snapshot);
    if (args.includes("--init")) {
      yield* writeBaseline(root, count(violations));
      return {
        output: `${BASELINE_FILE}: grandfathered ${violations.length} violation(s)`,
        code: 0,
      };
    }
    if (args.includes("--tighten")) {
      yield* writeBaseline(
        root,
        tighten(
          loaded.baseline,
          violations,
          unevaluated(config, snapshot, CHECKS, Object.keys(loaded.baseline)),
        ),
      );
      return { output: `${BASELINE_FILE}: tightened`, code: 0 };
    }
    return usage();
  });

const gardenCommand = (root: string, args: ReadonlyArray<string>) =>
  Effect.map(load(root, args), ({ config, snapshot, baseline }) => ({
    output: formatGarden(garden(config, snapshot, baseline)),
    code: 0,
  }));

const rules = () =>
  Effect.succeed({
    output: RULES.map((r) => `${r.id.padEnd(22)}${r.layer.padEnd(9)}${r.bugClass}`).join("\n"),
    code: 0,
  });

/** Every command, in the order the help lists them. */
export const COMMANDS: ReadonlyArray<Command> = [
  {
    name: "init",
    usage: `  mshape init <name> [--from <spec>]
      Create ./<name>: a new repo whose gate passes, with one starter test. --from installs
      monkeyshape from <spec> (a tarball path) instead of the registry, to try a release first.`,
    run: init,
  },
  {
    name: "sync",
    usage: `  mshape sync
      After a bump, bring what the installed package ships up to date: the shared skills in
      .agents/skills, .beads/PRIME.md, the PR template, and monkeyshape's hooks in
      .claude/settings.json. Skills and hooks the package doesn't ship are left alone.`,
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
    usage: `  mshape check [--only arch,refs,budgets,coverage,rules,skills,sync,beads]
      Run the checks; violations above .shape/baseline.json fail.`,
    run: check,
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
    usage: `  mshape rules
      List the custom rules and the bug class each one removes.`,
    run: rules,
  },
  {
    name: "track",
    usage: `  mshape track new <name>
      Start a track: worktree .agents/worktrees/<repo>@<name> on track/<name> from main (or
      from main's upstream, after fetching it, when that has commits main lacks),
      the shared handoffs and tracks.sharedPaths linked in, and a stub handoff. Shared paths
      come from the main checkout's shape.config.ts, from whichever checkout this runs.
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
      retired Messages section is mailed to its track first.
  mshape track current
      The track of this directory, name only; exit 1, saying why, outside a track.
  mshape track pr [--title <title>] [--body-file <path>]
      From a track's worktree: prints the PR's size against the batching default, runs the
      gate fresh, pushes track/<name> and opens its PR (--title and --body-file needed) or
      updates it. Writes only the Gate section, from that run; the rest of the body is
      --body-file's, or the PR's as it stands. Refuses, posting nothing, on uncommitted
      changes, a failing gate, a missing required section or a bead bd doesn't know.
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
    name: "review",
    usage: `  mshape review <n>
      Pull request <n>'s head from origin in a detached worktree .agents/worktrees/<repo>.pr-<n>,
      tracks.sharedPaths and the shared handoffs (.handoffs) linked in. Again later: put it
      exactly at the new head, printing the old one; edits to tracked files there are listed,
      then discarded.
      A session at main (or at another review) moves to the address review-<n>, so its mail
      is the review's; a session at a track stays there.
  mshape review rm <n>
      Remove that worktree, listing what it discards and review-<n>'s unread mail, its fetched
      ref and the sessions registered at review-<n>. Never the shared data or the handoffs.`,
    run: review,
  },
  {
    name: "msg",
    usage: `  mshape msg send <track> --subject <subject> [body]
      Leave a message in the mailbox of <track>, main or review-<n>, from this session's
      address, then push its subject to the sessions registered there. The subject is one line; it is all a
      notice shows. Quote the body; put -- before a body
      that starts with --.
  mshape msg inbox [--quiet]
      Unread messages at this session's address, oldest first. --quiet, for hooks: nothing
      when there are none or there is no address, and never a failure.
  mshape msg inbox --all
      Every address's unread mail, from any checkout, and mail left at one that is gone.
      For the milestone boundary; marks nothing read.
  mshape msg read <id>
      Print a message and mark it read at this address. Nothing else marks one read.
  mshape msg register
      Record this Claude Code session at its checkout's address (a track, main or review-<n>),
      or where it already is, so send notifies it at once: the SessionStart hook runs it.
      Silent outside every address; never fails.`,
    run: msg,
  },
];

const HELP: ReadonlyArray<string | undefined> = [undefined, "help", "--help"];

export const program = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [name, ...rest] = args;
    if (name === "--version") return { output: pkg.version, code: 0 };
    if (HELP.includes(name)) return { output: help(), code: 0 };
    const command = COMMANDS.find((entry) => entry.name === name);
    if (command === undefined)
      return { output: `mshape: unknown command '${name}'\n\n${help()}`, code: 2 };
    return yield* command.run(root, rest);
  });

// Only as the executable: tests import the table and the help without running a command.
if (import.meta.main) {
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
}
