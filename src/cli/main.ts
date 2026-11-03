#!/usr/bin/env bun
/** The `mshape` executable: the composition root, and the only place effects are run. */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import pkg from "../../package.json" with { type: "json" };
import { BASELINE_FILE, readBaseline, writeBaseline } from "../adapters/baseline.ts";
import { loadConfig } from "../adapters/config.ts";
import { initRepo } from "../adapters/init.ts";
import { mailInbox, mailRead, mailSend } from "../adapters/mail.ts";
import { reviewNew, reviewRm } from "../adapters/reviews.ts";
import { installSkills } from "../adapters/skills.ts";
import { trackCurrent, trackList, trackNew, trackRm } from "../adapters/tracks.ts";
import { loadSnapshot } from "../adapters/workspace.ts";
import { CHECKS, notices, prerequisites, runChecks, unevaluated } from "../core/check.ts";
import { garden } from "../core/garden.ts";
import { CLAUDE_SKILLS_LINK } from "../core/layout.ts";
import { formatInbox, formatMessage, formatSent } from "../core/mail.ts";
import type { CheckName } from "../core/model.ts";
import { applyBaseline, count, tighten } from "../core/ratchet.ts";
import { formatCheck, formatGarden, formatViolation } from "../core/report.ts";
import { RULES } from "../core/rules/registry.ts";
import { nextStep, REPO_NAME } from "../core/scaffold.ts";
import { formatCollisions, formatSync } from "../core/skills.ts";
import type { ConfigError, TrackError, WorkspaceError } from "../schemas/errors.ts";

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
    // A bare path is a tarball; bun would resolve it from the new repo, not from here.
    const spec = from === undefined || from.includes(":") ? from : `file:${resolve(root, from)}`;
    const dev = pkg.devDependencies;
    const result = yield* initRepo(`${root}/${name}`, name, PACKAGE_ROOT, {
      bun: Bun.version,
      monkeyshape: spec ?? pkg.version,
      effect: dev.effect,
      biome: dev["@biomejs/biome"],
      typescript: dev.typescript,
      typesBun: dev["@types/bun"],
    });
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

const track = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    const flags = rest.filter((arg) => arg.startsWith("--"));
    const names = rest.filter((arg) => !arg.startsWith("--"));
    const allowed = sub === "rm" ? ["--force", "--keep-handoff"] : [];
    const takesName = sub === "new" || sub === "rm";
    if (flags.some((flag) => !allowed.includes(flag))) return usage();
    if (names.length !== (takesName ? 1 : 0)) return usage();
    const name = names[0] ?? "";
    if (sub === "new") return { output: yield* trackNew(root, name, today()), code: 0 };
    if (sub === "list") return { output: yield* trackList(root), code: 0 };
    if (sub === "current") return { output: yield* trackCurrent(root), code: 0 };
    if (sub === "rm")
      return {
        output: yield* trackRm(
          root,
          name,
          {
            force: flags.includes("--force"),
            keepHandoff: flags.includes("--keep-handoff"),
            // rm fetches main's upstream; with no terminal to answer, a prompt would hang it.
            fetchEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          },
          (line) => Effect.sync(() => console.error(line)),
        ),
        code: 0,
      };
    return usage();
  });

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
    const message = yield* mailSend(root, to, subject, body, new Date(), randomHex);
    return { output: formatSent(message), code: 0 };
  });

/**
 * `--quiet` is the hooks' form: nothing when there's nothing to read or this isn't a track,
 * and never a failure, since a hook that fails would interrupt the session it serves. A
 * mailbox that can't be read is still said, as a note.
 */
const msgInbox = (root: string, quiet: boolean) =>
  Effect.map(mailInbox(root), ({ track, messages, unreadable }) => ({
    output: formatInbox(track, messages, unreadable, quiet),
    code: 0,
  })).pipe(
    Effect.catchTags({
      TrackError: (error) => (quiet ? Effect.succeed({ output: "", code: 0 }) : Effect.fail(error)),
      WorkspaceError: (error) =>
        quiet
          ? Effect.succeed({ output: `note: mshape msg inbox: ${error.message}`, code: 0 })
          : Effect.fail(error),
    }),
  );

const msg = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "send") return yield* msgSend(root, rest);
    if (sub === "inbox" && rest.length === 0) return yield* msgInbox(root, false);
    if (sub === "inbox" && rest.length === 1 && rest[0] === "--quiet")
      return yield* msgInbox(root, true);
    if (sub === "read" && rest.length === 1) {
      const { message, alreadyRead } = yield* mailRead(root, rest[0] ?? "");
      return { output: formatMessage(message, alreadyRead), code: 0 };
    }
    return usage();
  });

const review = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args.length === 1 && args[0] !== "rm")
      return {
        output: yield* reviewNew(root, args[0] ?? "", (line) =>
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

const skills = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (args[0] !== "sync") return usage();
    const { sync, linked } = yield* installSkills(`${PACKAGE_ROOT}/skills`, root);
    return {
      output: [
        formatSync(sync),
        ...(linked ? [`${CLAUDE_SKILLS_LINK}: linked`] : []),
        ...formatCollisions(sync),
      ].join("\n"),
      code: sync.collisions.length > 0 ? 1 : 0,
    };
  });

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
    const snapshot = yield* loadSnapshot(root, config, `${PACKAGE_ROOT}/skills`);
    const baseline = yield* readBaseline(root);
    return { config, snapshot, baseline };
  });

const check = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { config, snapshot, baseline } = yield* load(root, args);
    const blocked = prerequisites(config, snapshot);
    const only = parseOnly(args);
    if (typeof only === "string") return { output: only, code: 2 };
    const ratcheted = applyBaseline(
      runChecks(config, snapshot, only),
      baseline,
      unevaluated(snapshot, only, Object.keys(baseline)),
    );
    const result = { ...ratcheted, failing: [...blocked, ...ratcheted.failing] };
    const said = notices(config, snapshot).map((notice) => `note: ${notice}`);
    return {
      output: [...said, formatCheck(result)].join("\n"),
      code: result.failing.length + result.loose.length > 0 ? 1 : 0,
    };
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
      yield* writeBaseline(root, tighten(loaded.baseline, violations, unevaluated(snapshot)));
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
    name: "skills",
    usage: `  mshape skills sync
      Refresh the shared skills in .agents/skills from the installed package, after a bump.
      Skills the package doesn't ship are the repo's own and are left alone.`,
    run: skills,
  },
  {
    name: "check",
    usage: `  mshape check [--only arch,refs,budgets,coverage,rules,skills]
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
      Start a track: worktree .agents/worktrees/<repo>@<name> on track/<name> from main,
      the shared handoffs and tracks.sharedPaths linked in, and a stub handoff. Shared paths
      come from the main checkout's shape.config.ts, from whichever checkout this runs.
  mshape track list
      Every track: handoff status, open beads, commits in neither main nor origin/main,
      worktree. Restores missing handoff links; a track label with open beads and no track
      left is listed too. Offline: run git fetch to see merges done on the remote.
  mshape track current
      The track of this directory, name only; exit 1, saying why, outside a track.
  mshape track rm <name> [--force] [--keep-handoff]
      Remove a finished track: worktree, branch, handoff. Fetches main's upstream first, then
      refuses on uncommitted changes or work in neither main nor origin/main (by merge,
      rebase or squash); --force discards them. Also refuses while beads labelled
      track:<name> aren't closed, which --force doesn't override. Never touches main or other tracks.`,
    run: track,
  },
  {
    name: "review",
    usage: `  mshape review <n>
      Pull request <n>'s head from origin in a detached worktree .agents/worktrees/<repo>.pr-<n>,
      tracks.sharedPaths and the shared handoffs (.handoffs) linked in. Again later: put it
      exactly at the new head, printing the old one; edits to tracked files there are listed,
      then discarded.
  mshape review rm <n>
      Remove that worktree, listing what it discards, and its fetched ref. Never the shared data
      or the handoffs.`,
    run: review,
  },
  {
    name: "msg",
    usage: `  mshape msg send <track> --subject <subject> [body]
      Leave a message in <track>'s mailbox, from this track (or main, or review-<n>). The
      subject is one line; it is all a notice shows. Quote the body; put -- before a body
      that starts with --.
  mshape msg inbox [--quiet]
      This track's unread messages, oldest first. --quiet, for hooks: nothing when there are
      none or this isn't a track, and never a failure.
  mshape msg read <id>
      Print a message and mark it read for the whole track. Nothing else marks one read.`,
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
