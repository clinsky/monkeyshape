/**
 * The commands the loop runs in a session, whatever the harness (`LOOP_HOOKS`), how a hook or
 * a skill invokes `mshape`, and the hook-config JSON Claude Code and Codex share: events, each
 * a list of `{ matcher, hooks: [{ type: "command", command }] }`. An adapter renders
 * `LOOP_HOOKS` into its own commands and files (`src/harnesses/<id>/`); a new loop command is
 * one entry here.
 */
import type { LoopHook } from "../harnesses/harness.ts";
import { INSTALL_URL } from "./launch.ts";

/** The loop's commands, at each moment of a session, in the order they run. */
export const LOOP_HOOKS: ReadonlyArray<LoopHook> = [
  // The loop, the session's registration and its unread mail.
  { moment: "session-start", args: ["prime"] },
  // The unread mail at every prompt, until it is read.
  { moment: "prompt", args: ["msg", "inbox", "--quiet"] },
];

/** The hook events monkeyshape uses, as Claude Code and Codex name them. */
export type HookEvent = "SessionStart" | "UserPromptSubmit";

export interface Hook {
  readonly event: HookEvent;
  /** Which sources trigger it (for SessionStart: startup, resume, clear, compact); "" is all. */
  readonly matcher: string;
  /** A shell command, run from the session's directory. */
  readonly command: string;
  /** Commands an older monkeyshape wrote for this hook: sync replaces them with `command`. */
  readonly retired?: ReadonlyArray<string>;
}

/** POSIX single quotes, only when needed: hook commands stay readable. */
const quote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * `mshape <args>` as a shell command, for a hook and for a skill (D-run-mshape): the `mshape`
 * installed once per machine, which runs the version the repo pins.
 */
export const mshapeCommand = (args: ReadonlyArray<string>): string =>
  ["mshape", ...args.map(quote)].join(" ");

/** What a check's message tells an agent to run to refresh what the package ships. */
export const SYNC_COMMAND = mshapeCommand(["sync"]);

/**
 * A hook's command that degrades to a note: `command`, or, when it can't run, `note` and
 * exit 0. A hook failing at every prompt says nothing useful. Only commands that never fail
 * once they run are wrapped (`msg register`, `msg inbox --quiet`, `bd prime`), so any failure
 * is one of not running: the launcher offline with the pinned version not cached, say, whose
 * own message names the URL just before the note.
 */
export const withNote = (command: string, note: string, otherwise?: string): string =>
  otherwise === undefined
    ? `${command} || echo ${quote(`note: ${note}`)}`
    : `${command} || { echo ${quote(`note: ${note}`)}; ${otherwise}; }`;

/**
 * Where a hook looks for `mshape` after the session's PATH: where `install.sh` puts it. A
 * session started from a shell that sets PATH only for login shells has no `~/.local/bin`.
 */
export const MSHAPE_FALLBACK = "$HOME/.local/bin";

const MSHAPE_NOT_INSTALLED = `mshape is neither on this session's PATH nor in ~/.local/bin, so this hook did nothing. Install it once per machine: curl -fsSL ${INSTALL_URL} | sh`;

const MSHAPE_FAILED =
  "mshape could not run here, so this hook did nothing. Run the hook's command in a terminal to see why.";

/**
 * `command`, run with `mshape` found when the hook runs: the session's PATH first, then
 * `MSHAPE_FALLBACK`. `$HOME` stays a variable, so `.claude/settings.json` is the same on every
 * machine. Without `mshape`, a note naming the install line, and exit 0.
 */
export const withMshape = (command: string, otherwise?: string): string =>
  `PATH="$PATH:${MSHAPE_FALLBACK}"; if command -v mshape >/dev/null; then ${command}; else echo ${quote(`note: ${MSHAPE_NOT_INSTALLED}`)}${otherwise === undefined ? "" : `; ${otherwise}`}; fi`;

/**
 * What hooks before 0.6 ran: `mshape` through the package script, with bun found on the PATH or
 * in ~/.bun/bin. Kept only so sync knows them as monkeyshape's and replaces them.
 */
export const legacy = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
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

/**
 * `mshape <args>` as a hook runs it: found where it is installed, degrading to a note, and
 * then to `otherwise` when mshape can't run.
 */
export const hookCommand = (args: ReadonlyArray<string>, otherwise?: string): string =>
  withMshape(withNote(mshapeCommand(args), MSHAPE_FAILED, otherwise), otherwise);

/**
 * What the session-start hook still loads when mshape can't run (not installed, offline with
 * its pinned version not cached): bd's own primer, which prints the repo's PRIME.md, as every
 * hook before 0.7 did. Silent when bd can't run either: mshape's note already said why.
 */
export const PRIME_FALLBACK = "bd prime 2>/dev/null || true";

/** What 0.6's hooks ran for `args`, and what hooks before 0.6 did: sync replaces them all. */
export const before07 = (args: ReadonlyArray<string>): ReadonlyArray<string> => [
  hookCommand(args),
  ...legacy(args),
];

/** A hook config's `hooks` key: each hook under its event, in list order. */
export const settingsHooks = (hooks: ReadonlyArray<Hook>): Record<string, Array<unknown>> => {
  const events: Record<string, Array<unknown>> = {};
  for (const hook of hooks)
    events[hook.event] = [
      ...(events[hook.event] ?? []),
      { matcher: hook.matcher, hooks: [{ type: "command", command: hook.command }] },
    ];
  return events;
};

/**
 * A hook config's text: `current` (the parsed file, or nothing for a new repo) with its `hooks`
 * key replaced. The list owns `hooks` and nothing else, since the harness and the user keep
 * other keys (Claude Code's `permissions`, `env`) in the same file.
 */
export const renderSettings = (
  hooks: ReadonlyArray<Hook>,
  current: Readonly<Record<string, unknown>> = {},
): string => `${JSON.stringify({ ...current, hooks: settingsHooks(hooks) }, null, 2)}\n`;

const hookEntries = (
  settings: Readonly<Record<string, unknown>>,
  event: string,
): Array<unknown> => {
  const { hooks } = settings;
  if (typeof hooks !== "object" || hooks === null || Array.isArray(hooks)) return [];
  const entries = (hooks as Record<string, unknown>)[event];
  return Array.isArray(entries) ? entries : [];
};

/** Whether `settings` already runs `hook`: an entry of its event with its matcher and command. */
const runs = (settings: Readonly<Record<string, unknown>>, hook: Hook): boolean =>
  hookEntries(settings, hook.event).some((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const { matcher, hooks } = entry as { matcher?: unknown; hooks?: unknown };
    return (
      (matcher ?? "") === hook.matcher &&
      Array.isArray(hooks) &&
      hooks.some(
        (inner) =>
          typeof inner === "object" &&
          inner !== null &&
          (inner as { command?: unknown }).command === hook.command,
      )
    );
  });

/** The hooks of `hooks` that `settings` (a parsed settings.json) doesn't run. */
export const missingHooks = (
  settings: Readonly<Record<string, unknown>>,
  hooks: ReadonlyArray<Hook>,
): ReadonlyArray<Hook> => hooks.filter((hook) => !runs(settings, hook));

/**
 * An event's entries without the commands in `drop`: an entry left with no command goes too.
 * Anything not shaped like an entry is the repo's, and kept as it is.
 */
const without = (entries: ReadonlyArray<unknown>, drop: ReadonlySet<string>): Array<unknown> => {
  const dropped = (inner: unknown) =>
    typeof inner === "object" &&
    inner !== null &&
    drop.has((inner as { command?: unknown }).command as string);
  return entries.flatMap((entry) => {
    const inner = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(inner) || !inner.some(dropped)) return [entry];
    const kept = inner.filter((hook) => !dropped(hook));
    return kept.length === 0 ? [] : [{ ...(entry as object), hooks: kept }];
  });
};

/** The commands of `ours` that `settings` runs under `event` but `hooks` doesn't ship there. */
const staleIn = (
  settings: Readonly<Record<string, unknown>>,
  event: string,
  hooks: ReadonlyArray<Hook>,
  ours: ReadonlySet<string>,
): ReadonlySet<string> => {
  const shipped = new Set(hooks.filter((hook) => hook.event === event).map((hook) => hook.command));
  const stale = new Set<string>();
  for (const entry of hookEntries(settings, event)) {
    const inner = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(inner)) continue;
    for (const hook of inner) {
      const command = (hook as { command?: unknown } | null)?.command;
      if (typeof command === "string" && ours.has(command) && !shipped.has(command))
        stale.add(command);
    }
  }
  return stale;
};

/** Every command monkeyshape ever wrote for `hooks`: theirs now and every retired one. */
export const ownCommands = (hooks: ReadonlyArray<Hook>): ReadonlySet<string> =>
  new Set(hooks.flatMap((hook) => [hook.command, ...(hook.retired ?? [])]));

/**
 * What `settings` runs that monkeyshape wrote and no longer ships, by event: a retired
 * command, or one of `ours` (`ownCommands` of every hook this adapter could render) that
 * `hooks` drops. An empty map is in step.
 */
export const staleHooks = (
  settings: Readonly<Record<string, unknown>>,
  hooks: ReadonlyArray<Hook>,
  ours: ReadonlySet<string> = ownCommands(hooks),
): ReadonlyArray<{ readonly event: string; readonly command: string }> => {
  const { hooks: existing } = settings;
  const events =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? Object.keys(existing)
      : [];
  return events.flatMap((event) =>
    [...staleIn(settings, event, hooks, ours)].map((command) => ({ event, command })),
  );
};

/**
 * `settings` with monkeyshape's entries made exactly `hooks`: what it wrote and no longer
 * ships (a command in `ours` that `hooks` doesn't run under that event) removed, each missing
 * hook appended after the repo's entries under its event, and everything else, the repo's own
 * hooks included, kept where it is. `mergeHooks(settings, [], ours)` removes all of
 * monkeyshape's; an event it empties goes.
 */
export const mergeHooks = (
  settings: Readonly<Record<string, unknown>>,
  hooks: ReadonlyArray<Hook>,
  ours: ReadonlySet<string> = ownCommands(hooks),
): string => {
  const { hooks: existing } = settings;
  const current =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = {};
  const added = settingsHooks(missingHooks(settings, hooks));
  for (const event of new Set([...Object.keys(current), ...Object.keys(added)])) {
    const stale = staleIn(settings, event, hooks, ours);
    const was = current[event];
    // An event the file doesn't have yet starts empty; one that isn't a list is the repo's.
    const entries = was === undefined ? [] : Array.isArray(was) ? without(was, stale) : was;
    const next = Array.isArray(entries) ? [...entries, ...(added[event] ?? [])] : entries;
    // An event only monkeyshape's entries filled, now empty, goes; the repo's empty one stays.
    if (Array.isArray(next) && next.length === 0 && stale.size > 0) continue;
    merged[event] = next;
  }
  return `${JSON.stringify({ ...settings, hooks: merged }, null, 2)}\n`;
};

/** `mergeHooks` with only `hooks`' retired commands taken as monkeyshape's to remove. */
export const addHooks = (
  settings: Readonly<Record<string, unknown>>,
  hooks: ReadonlyArray<Hook>,
): string => mergeHooks(settings, hooks, ownCommands(hooks));
