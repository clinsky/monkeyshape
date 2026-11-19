/**
 * Claude Code, the first harness adapter: its pure part. Claude Code records each running
 * session in its config directory (`sessions/<pid>.json`, undocumented, so read strictly and
 * by protocol version) and publishes a key per process (`<pid>.<hash>.key`) for its
 * cross-session socket. Its I/O is `src/adapters/harnesses/claude-code.ts`: this module says
 * what those records mean, who runs a command, and what a notice looks like on the socket.
 */
import {
  type Hook,
  type HookEvent,
  hookCommand,
  LOOP_HOOKS,
  mergeHooks,
  missingHooks,
  ownCommands,
  PRIME_FALLBACK,
  quote,
  staleHooks,
  withNote,
} from "../../core/hooks.ts";
import { REGISTRATION_GRACE_MS } from "../../core/notices.ts";
import type {
  Harness,
  Identity,
  Invocation,
  JsonObject,
  LoopHook,
  Moment,
  Registration,
  SessionStatus,
} from "../harness.ts";

/** Committed symlink: Claude Code reads project skills only from here. */
export const CLAUDE_SKILLS_LINK = ".claude/skills";

/** The link's text, relative to `.claude/`, so it resolves in every clone and worktree. */
export const CLAUDE_SKILLS_TARGET = "../.agents/skills";

/** Where Claude Code reads the project's hooks, repo-relative. */
export const SETTINGS_FILE = ".claude/settings.json";

const EVENTS: Readonly<Record<Moment, HookEvent>> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
};

/**
 * What hooks before 0.6 ran: `mshape` through the package script, with bun found on the PATH or
 * in ~/.bun/bin. Kept only so sync knows them as monkeyshape's and replaces them.
 */
const legacy = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const script = ["bun", "run", "--silent", "mshape", ...args.map(quote)].join(" ");
  const missing04 =
    'mshape could not run here, so this hook did nothing. Either bun is not on this session\'s PATH (run `command -v bun`; add bun\'s bin directory, often ~/.bun/bin, to the PATH Claude Code starts with), or monkeyshape is not installed (run `bun install`; package.json needs the script `"mshape": "mshape"`).';
  const missing =
    'mshape could not run here, so this hook did nothing. Run `bun install`; package.json needs the script `"mshape": "mshape"`.';
  const noBun =
    "bun is neither on this session's PATH nor in ~/.bun/bin, so this hook did nothing. Install bun (https://bun.sh), or add the directory holding it to the PATH Claude Code starts with.";
  const withBun = (command: string) =>
    `PATH="$PATH:$HOME/.bun/bin"; if command -v bun >/dev/null; then ${command}; else echo ${quote(`note: ${noBun}`)}; fi`;
  return [
    script,
    withNote(script, missing),
    withNote(script, missing04),
    withBun(withNote(script, missing)),
  ];
};

/** What 0.6's hooks ran for `args`, and what hooks before 0.6 did: sync replaces them all. */
export const before07 = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
  hookCommand(args),
  ...legacy(args),
];

/**
 * What monkeyshape's hooks ran before 0.7 for each loop command, so sync knows them as its own
 * and replaces them: 0.6's three SessionStart hooks (bd's primer, `msg register`, the inbox)
 * are `prime` now.
 */
const RETIRED: Readonly<Record<string, ReadonlyArray<string>>> = {
  prime: [
    "bd prime --hook-json",
    withNote(
      "bd prime --hook-json",
      "bd could not run here, so this session has no beads primer. Install bd: https://github.com/steveyegge/beads",
    ),
    ...before07(["msg", "register"]),
    ...before07(["msg", "inbox", "--quiet"]),
  ],
  "msg inbox --quiet": before07(["msg", "inbox", "--quiet"]),
};

/**
 * Claude Code's hook for each loop command: `mshape --harness claude-code <args>`, found where
 * it is installed; `prime` falls back to bd's primer when mshape can't run.
 */
export const claudeHooks = (hooks: ReadonlyArray<LoopHook>): ReadonlyArray<Hook> =>
  hooks.map((hook) => ({
    event: EVENTS[hook.moment],
    matcher: "",
    command: hookCommand(
      ["--harness", "claude-code", ...hook.args],
      hook.args[0] === "prime" ? PRIME_FALLBACK : undefined,
    ),
    retired: RETIRED[hook.args.join(" ")] ?? [],
  }));

/** The hooks monkeyshape writes into Claude Code's settings now. */
export const CLAUDE_HOOKS: ReadonlyArray<Hook> = claudeHooks(LOOP_HOOKS);

/** Every command monkeyshape writes or wrote into Claude Code's settings. */
const OURS = ownCommands(claudeHooks(LOOP_HOOKS));

/** The fields of Claude Code's session file that a notice depends on. */
export interface ClaudeSession {
  readonly pid: number;
  /** The directory the session runs in, when the record says; `track rm` reads it. */
  readonly cwd?: string;
  readonly sessionId: string;
  readonly procStart: string;
  readonly peerProtocol: number;
  readonly messagingSocketPath: string;
}

/**
 * The fields of a published key file (`<pid>.<hash>.key`) a sender uses. Keys of earlier
 * processes with the same pid can linger, so `procStart` says which process published it.
 */
export interface ClaudeKey {
  readonly peerToken: string;
  readonly procStart: string;
}

/** The one socket protocol notices are written for (Claude Code 2.1.317). */
export const PEER_PROTOCOL = 1;

/** A session id as Claude Code writes it. */
export const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Claude Code's session file, or undefined when it lacks a field a notice needs. */
export const decodeClaudeSession = (text: string): ClaudeSession | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { pid, cwd, sessionId, procStart, peerProtocol, messagingSocketPath } = value;
  return typeof pid === "number" &&
    typeof sessionId === "string" &&
    typeof procStart === "string" &&
    typeof peerProtocol === "number" &&
    typeof messagingSocketPath === "string"
    ? {
        pid,
        ...(typeof cwd === "string" ? { cwd } : {}),
        sessionId,
        procStart,
        peerProtocol,
        messagingSocketPath,
      }
    : undefined;
};

export const decodeClaudeKey = (text: string): ClaudeKey | undefined => {
  const value = object(text);
  if (value === undefined) return undefined;
  const { peerToken, procStart } = value;
  return typeof peerToken === "string" && typeof procStart === "string"
    ? { peerToken, procStart }
    : undefined;
};

/**
 * Whether a registration's session is still running, from Claude Code's current record of
 * its process (found by pid, else by session id). A registration ahead of the record (the
 * hook runs before Claude Code writes it at start, or updates it after /clear) is `pending`
 * for `REGISTRATION_GRACE_MS`, so a send in that window doesn't prune it.
 */
export const claudeStatus = (
  registration: Registration,
  record: ClaudeSession | undefined,
  now: Date,
): SessionStatus => {
  // A /clear starts a new session id in the same process; a reused pid runs another one.
  if (record !== undefined && record.sessionId === registration.session) return { kind: "live" };
  const age = now.getTime() - Date.parse(registration.registered);
  if (age >= 0 && age < REGISTRATION_GRACE_MS) return { kind: "pending" };
  return {
    kind: "gone",
    reason:
      record === undefined
        ? "its Claude Code session has ended"
        : "its process now runs another session",
  };
};

/** Where a notice goes on Claude Code's socket, read at send time and never stored. */
export interface Target {
  readonly socket: string;
  readonly token: string;
}

/**
 * The socket and key for a live session's notice, or why there are none: a protocol this
 * mshape doesn't speak, or no key published for the running process.
 */
export const claudeTarget = (
  record: ClaudeSession,
  keys: ReadonlyArray<ClaudeKey>,
): Target | { readonly reason: string } => {
  if (record.peerProtocol !== PEER_PROTOCOL)
    return {
      reason: `Claude Code speaks messaging protocol ${record.peerProtocol}; this mshape knows ${PEER_PROTOCOL}`,
    };
  // The live process's key, whatever order the directory lists leftovers in.
  const key = keys.find((candidate) => candidate.procStart === record.procStart);
  return key === undefined
    ? { reason: "Claude Code published no key for it" }
    : { socket: record.messagingSocketPath, token: key.peerToken };
};

/** The two lines Claude Code's socket reads: auth, then the notice as a user message. */
export const socketPayload = (token: string, line: string): string =>
  `${JSON.stringify({ type: "auth", token })}\n${JSON.stringify({
    type: "user",
    message: { role: "user", content: line },
  })}\n`;

/**
 * Sessions running inside a worktree whether or not they registered (one started before the
 * register hook existed, or whose `register` only gave a note): by the record's `cwd`.
 * Paths are compared as given, so the caller resolves symlinks on both sides first.
 */
export const sessionsIn = (
  worktree: string,
  records: ReadonlyArray<ClaudeSession>,
): ReadonlyArray<string> =>
  records
    .filter((record) => record.cwd === worktree || record.cwd?.startsWith(`${worktree}/`))
    .map((record) => record.sessionId);

/** A hook's `session_id`, from the JSON Claude Code writes on its stdin. */
const hookSession = (input: string | undefined): string | undefined => {
  if (input === undefined) return undefined;
  const value = object(input);
  const session = value?.["session_id"];
  return typeof session === "string" && session !== "" ? session : undefined;
};

/**
 * Claude Code's session: the hook's `session_id`, else `CLAUDE_CODE_SESSION_ID`, which
 * Claude Code sets in every command it runs; the process from `CLAUDE_PID`. Claims a hook's
 * input without `--harness` too, since 0.6.0's hooks don't pass it. A session id that isn't
 * Claude Code's shape is no claim.
 */
const identify = (invocation: Invocation): Identity | undefined => {
  const env = (name: string) => {
    const value = invocation.env[name];
    return value === undefined || value === "" ? undefined : value;
  };
  const session = hookSession(invocation.hookInput) ?? env("CLAUDE_CODE_SESSION_ID");
  const pid = Number(env("CLAUDE_PID") ?? "");
  const identity: Identity = {
    harness: "claude-code",
    ...(session !== undefined && CLAUDE_SESSION_ID.test(session) ? { session } : {}),
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
  };
  return identity.session === undefined && identity.pid === undefined ? undefined : identity;
};

const describeHook = (hook: Hook): string => `${hook.event}: \`${hook.command}\``;

export const claudeCode: Harness = {
  id: "claude-code",
  name: "Claude Code",
  moments: ["session-start", "prompt"],
  files: (loop) => {
    const hooks = claudeHooks(loop);
    return [
      {
        kind: "owned-entries",
        path: SETTINGS_FILE,
        merge: (current: JsonObject | undefined) => mergeHooks(current ?? {}, hooks, OURS),
        missing: (current: JsonObject | undefined) => [
          ...missingHooks(current ?? {}, hooks).map((hook) => `doesn't run ${describeHook(hook)}`),
          ...staleHooks(current ?? {}, hooks, OURS).map(
            (hook) =>
              `still runs ${hook.event}: \`${hook.command}\`, which monkeyshape no longer ships`,
          ),
        ],
      },
    ];
  },
  skills: { kind: "link", path: CLAUDE_SKILLS_LINK, target: CLAUDE_SKILLS_TARGET },
  identify,
  invoke: (skill, args) => `/${skill}${args === undefined ? "" : ` ${args}`}`,
  identifiedBy: "a hook's session_id, CLAUDE_CODE_SESSION_ID or CLAUDE_PID",
};
