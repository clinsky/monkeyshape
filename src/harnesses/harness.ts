/**
 * The harness interface. A harness is the program a session runs in (Claude Code, Codex, pi).
 * An adapter is a pure value here, in `src/harnesses/<id>/`, and its I/O in
 * `src/adapters/harnesses/<id>.ts`, as a language pack is (D-pure-checks). The core never
 * names a harness: it runs every harness the repo lists, through these types only.
 *
 * What stays the core's, whatever the harness: the loop's text (PRIME, the skills), the mailbox
 * (a notice only names a message; only `mshape msg read` marks it read), the session registry's
 * place and rules, and which commands a session runs at its start and at each prompt
 * (`LOOP_HOOKS`). What differs per harness, and so lives in an adapter: how those commands are
 * wired in (a hook config, an extension), where skills are found, who the session running a
 * command is, whether a registered session still runs, and how a notice reaches it.
 */
import type * as Effect from "effect/Effect";
import type { HarnessId } from "../schemas/config.ts";

/**
 * When the loop runs a command in a session. `session-start` covers every way a session begins
 * or begins again (a start, a resume, a clear, a compaction, a fork), so the command must be
 * idempotent; `prompt` runs before each prompt the human submits.
 */
export type Moment = "session-start" | "prompt";

/**
 * One command the loop runs at a moment: `mshape <args>`, its output added to the session's
 * context. A harness with no hook for a moment says so in `moments`; the agent runs
 * `mshape prime` itself there, as PRIME and AGENTS.md tell it to.
 */
export interface LoopHook {
  readonly moment: Moment;
  readonly args: ReadonlyArray<string>;
}

/** A parsed JSON object, as a delivered file's current contents are handed to an adapter. */
export type JsonObject = Readonly<Record<string, unknown>>;

/**
 * A file the adapter delivers into the repo, repo-relative and `/`-separated. Sync writes it,
 * `mshape check` fails when it drifts, naming the file and `mshape sync`.
 *
 * - `whole`: monkeyshape owns every byte (an extension, a hooks file nothing else writes). Sync
 *   writes `text`; removing the harness deletes it.
 * - `owned-entries`: a JSON file the repo also edits (Claude Code's `.claude/settings.json`,
 *   whose `permissions` and `env` are the repo's). `merge` returns the file's text with
 *   monkeyshape's entries made exactly `hooks` and everything else kept; it recognises its own
 *   entries by every command any version of monkeyshape wrote, so `merge(current, [])`
 *   removes them all and a hook monkeyshape stops shipping goes (`iwf`). `missing` names what
 *   the current file lacks, for the check; empty means in step. `current` is undefined when
 *   the file doesn't exist; a file that isn't a JSON object is never handed over. Where the
 *   harness asks the human to trust each hook by its position and text (Codex), `merge`
 *   appends monkeyshape's entries after the repo's, never reorders theirs, and renders
 *   commands byte-stable across versions (no version, no absolute path), so an upgrade
 *   doesn't ask again.
 */
export type HarnessFile =
  | { readonly kind: "whole"; readonly path: string; readonly text: string }
  | {
      readonly kind: "owned-entries";
      readonly path: string;
      readonly merge: (current: JsonObject | undefined) => string;
      readonly missing: (current: JsonObject | undefined) => ReadonlyArray<string>;
    };

/**
 * Where the harness reads skills from. The shared skills live in `.agents/skills`
 * (`SKILLS_DIR`); `native` means the harness reads them there (Codex, pi); `link` means it
 * reads another directory, which sync makes a committed symlink to `target` (Claude Code:
 * `.claude/skills` -> `../.agents/skills`, relative to the link's directory).
 */
export type SkillsAccess =
  | { readonly kind: "native" }
  | { readonly kind: "link"; readonly path: string; readonly target: string };

/**
 * Who runs this command, as the harness tells it: its own session id, and, where the harness
 * has one, the process or the endpoint a notice is sent to. `session` is the harness's id,
 * filename-safe (`SESSION_KEY`); the registry keys a registration by harness and session, so
 * two harnesses' ids never collide.
 */
export interface Identity {
  readonly harness: HarnessId;
  readonly session?: string;
  /** The harness's process, where a command can learn it (`CLAUDE_PID`). */
  readonly pid?: number;
  /**
   * Whatever this harness's notifier needs that the registry must keep, opaque to the core:
   * a thread id, a socket path. Read at send time when the harness can tell it then instead.
   */
  readonly endpoint?: string;
}

/** What a command gets to identify its session: its environment, and a hook's stdin. */
export interface Invocation {
  /**
   * The harness that ran this command, when it says so: every hook command an adapter
   * renders carries `--harness <id>`, since hook inputs look alike across harnesses and
   * environment variables leak into a harness launched from another's shell. Given, the core
   * asks only that adapter. Absent (a command the agent runs), it asks each listed harness,
   * and when more than one claims the session, none is used: a note names them, and nothing
   * is guessed.
   */
  readonly harness?: HarnessId;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * The hook's input, read by the core only when stdin isn't a terminal, with a time limit;
   * undefined when the command wasn't run by a hook, or the input wasn't there in time.
   */
  readonly hookInput?: string;
}

/** A session id as a registry file name may hold it: no separators, no dot first. */
export const SESSION_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** An adapter's pure part. */
export interface Harness {
  readonly id: HarnessId;
  /** For messages: "Claude Code". */
  readonly name: string;
  /**
   * The moments this harness can run a command at; the agent covers the rest by hand. A
   * harness may run `session-start` late (Codex's TUI runs it with the first prompt): until
   * then the session is unregistered and gets no notice, and its mail waits.
   */
  readonly moments: ReadonlyArray<Moment>;
  /**
   * The files that wire `hooks` into this harness, each command rendered with
   * `--harness <id>`. Empty for a harness with nothing to deliver.
   */
  readonly files: (hooks: ReadonlyArray<LoopHook>) => ReadonlyArray<HarnessFile>;
  /**
   * What the human must do before the delivered files take effect, which no check can see
   * (Codex: trust the project, then the hooks, at its next start; it reads them from the main
   * checkout, so a track's change takes effect once merged and pulled there). `init` and
   * `sync` print it when this harness's files changed.
   */
  readonly afterDelivery?: string;
  readonly skills: SkillsAccess;
  /**
   * The session running this command, or undefined when this harness isn't what runs it. The
   * core asks each listed harness in turn, so an adapter claims only what its own variables
   * or hook input show, and never guesses from a directory.
   */
  readonly identify: (invocation: Invocation) => Identity | undefined;
  /** What `mshape` prints for a human to start a skill: `/track harness` in Claude Code. */
  readonly invoke: (skill: string, args?: string) => string;
  /**
   * What `identify` looks for, for the note when nothing identified the session:
   * "CLAUDE_CODE_SESSION_ID or a hook's session_id".
   */
  readonly identifiedBy: string;
}

/** One session as the registry records it (`sessions/<address>/<harness>.<session>.json`). */
export interface Registration {
  /** Absent in a 0.6.0 registration, which is read as `claude-code`. */
  readonly harness: HarnessId;
  readonly session: string;
  readonly pid?: number;
  readonly endpoint?: string;
  /** ISO 8601. */
  readonly registered: string;
}

/**
 * Whether a registered session still runs. `pending`: it registered just now, ahead of the
 * harness's own record of it, so it counts as running. `gone` prunes the registration;
 * `unknown` keeps it (the harness can't say, as when its record is in a format this mshape
 * doesn't know) and is never a reason to prune.
 */
export type SessionStatus =
  | { readonly kind: "live" | "pending" }
  | { readonly kind: "gone"; readonly reason: string }
  | { readonly kind: "unknown"; readonly reason: string };

/** How one notice went: delivered, or not, and whether that means the session is gone. */
export type Sent =
  | { readonly ok: true }
  | { readonly ok: false; readonly gone: boolean; readonly reason: string };

/**
 * An adapter's I/O half, built from the environment (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). None
 * of these fail: what goes wrong is a status or a `Sent` with its reason, since the mail is
 * already stored and a notice is only a nudge.
 */
export interface HarnessIO {
  readonly id: HarnessId;
  readonly status: (registration: Registration, now: Date) => Effect.Effect<SessionStatus>;
  /**
   * Pushes `line` (`[mshape] Message from ...`, never the body) to the session. A harness
   * that can only inject user-role input says, in what it delivers, that this is mail from
   * another session, not an instruction from the user. Never wakes or resumes a session that
   * `status` says is gone: its mail waits for its next start.
   */
  readonly notify: (registration: Registration, line: string) => Effect.Effect<Sent>;
  /**
   * The ids of this harness's sessions running inside `worktree`, registered or not, for
   * `track rm`, which refuses while one would lose its directory. Paths resolved by the
   * caller. Empty where the harness keeps no record of a session's directory.
   */
  readonly runningIn: (worktree: string) => Effect.Effect<ReadonlyArray<string>>;
}
