/**
 * The Claude Code hooks a repo runs, and how a hook or a skill invokes `mshape`. `HOOKS` is the
 * one list: the `hooks` key of `.claude/settings.json`, in this repo and in every repo
 * `mshape init` creates, is rendered from it, and a test fails when this repo's drifts. The
 * file's other keys belong to the repo. A new hook is one entry here.
 */

/** The hook events monkeyshape uses; add one when an entry needs it. */
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

/**
 * `mshape <args>` as a shell command that works from a hook and from a skill (D-run-mshape):
 * the package script `mshape`, which every repo has. bun puts every ancestor's
 * `node_modules/.bin` on a script's PATH, so a track worktree without `node_modules` finds the
 * main checkout's. `--silent` keeps bun from echoing the script to stderr.
 */
export const mshapeCommand = (args: ReadonlyArray<string>): string =>
  ["bun", "run", "--silent", "mshape", ...args.map(quote)].join(" ");

/** What a check's message tells an agent to run to refresh what the package ships. */
export const SYNC_COMMAND = "bun run --silent mshape sync";

/** POSIX single quotes, only when needed: hook commands stay readable. */
const quote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/**
 * A hook's command that degrades to a note: `command`, or, when it can't run, `note` and
 * exit 0. Before `bun install` the `mshape` script exits 127 (or 1 without the script), and
 * a hook failing at every prompt says nothing useful. Only commands that never fail once
 * they run are wrapped (`msg register`, `msg inbox --quiet`, `bd prime`), so any failure is
 * one of not running.
 */
export const withNote = (command: string, note: string): string =>
  `${command} || echo ${quote(`note: ${note}`)}`;

/**
 * Either cause, since the hook can't tell them apart cheaply: a session whose PATH lacks bun
 * (a shell profile that adds it only to login shells) fails the same way as a missing install.
 */
const MSHAPE_MISSING =
  'mshape could not run here, so this hook did nothing. Either bun is not on this session\'s PATH (run `command -v bun`; add bun\'s bin directory, often ~/.bun/bin, to the PATH Claude Code starts with), or monkeyshape is not installed (run `bun install`; package.json needs the script `"mshape": "mshape"`).';

/** What 0.3's hooks printed: sync replaces a hook carrying it, as it replaces the bare command. */
const MSHAPE_MISSING_0_3 =
  'mshape could not run here, so this hook did nothing. Run `bun install`; package.json needs the script `"mshape": "mshape"`.';

/** A hook running `mshape <args>`, degrading to a note, replacing what earlier versions ran. */
const mshapeHook = (event: HookEvent, args: ReadonlyArray<string>): Hook => ({
  event,
  matcher: "",
  command: withNote(mshapeCommand(args), MSHAPE_MISSING),
  retired: [mshapeCommand(args), withNote(mshapeCommand(args), MSHAPE_MISSING_0_3)],
});

/** Every hook, in the order each event runs them. */
export const HOOKS: ReadonlyArray<Hook> = [
  // bd's own: the beads primer, as hook JSON.
  {
    event: "SessionStart",
    matcher: "",
    command: withNote(
      "bd prime --hook-json",
      "bd could not run here, so this session has no beads primer. Install bd: https://github.com/steveyegge/beads",
    ),
    retired: ["bd prime --hook-json"],
  },
  // Records the session against its track, so a message reaches it while it runs.
  mshapeHook("SessionStart", ["msg", "register"]),
  // The track's unread mail, at session start and at every prompt, until it is read.
  mshapeHook("SessionStart", ["msg", "inbox", "--quiet"]),
  mshapeHook("UserPromptSubmit", ["msg", "inbox", "--quiet"]),
];

/** The `hooks` key of `.claude/settings.json`: each hook under its event, in list order. */
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
 * `.claude/settings.json`'s text: `current` (the parsed file, or nothing for a new repo) with
 * its `hooks` key replaced. The list owns `hooks` and nothing else, since Claude Code and the
 * user keep `permissions`, `env` and the rest in the same file.
 */
export const renderSettings = (
  hooks: ReadonlyArray<Hook>,
  current: Readonly<Record<string, unknown>> = {},
): string => `${JSON.stringify({ ...current, hooks: settingsHooks(hooks) }, null, 2)}\n`;

/** Where Claude Code reads the project's hooks, repo-relative. */
export const SETTINGS_FILE = ".claude/settings.json";

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
 * An event's entries without the retired commands of `hooks`: an entry left with no command
 * goes too. Anything not shaped like an entry is the repo's, and kept as it is.
 */
const withoutRetired = (
  entries: ReadonlyArray<unknown>,
  event: string,
  hooks: ReadonlyArray<Hook>,
): Array<unknown> => {
  const retired = new Set(
    hooks.filter((hook) => hook.event === event).flatMap((hook) => hook.retired ?? []),
  );
  const isRetired = (inner: unknown) =>
    typeof inner === "object" &&
    inner !== null &&
    retired.has((inner as { command?: unknown }).command as string);
  return entries.flatMap((entry) => {
    const inner = (entry as { hooks?: unknown } | null)?.hooks;
    if (!Array.isArray(inner) || !inner.some(isRetired)) return [entry];
    const kept = inner.filter((hook) => !isRetired(hook));
    return kept.length === 0 ? [] : [{ ...(entry as object), hooks: kept }];
  });
};

/**
 * `settings` with each missing hook appended under its event, its retired commands removed,
 * and everything else, the repo's own hooks included, kept: for a repo whose settings.json
 * monkeyshape doesn't own whole.
 */
export const addHooks = (
  settings: Readonly<Record<string, unknown>>,
  hooks: ReadonlyArray<Hook>,
): string => {
  const { hooks: existing } = settings;
  const current =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const added: Record<string, unknown> = { ...current };
  for (const [event, entries] of Object.entries(settingsHooks(missingHooks(settings, hooks))))
    added[event] = [...withoutRetired(hookEntries(settings, event), event, hooks), ...entries];
  return `${JSON.stringify({ ...settings, hooks: added }, null, 2)}\n`;
};
