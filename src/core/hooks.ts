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

/** Every hook, in the order each event runs them. */
export const HOOKS: ReadonlyArray<Hook> = [
  // bd's own: the beads primer, as hook JSON.
  { event: "SessionStart", matcher: "", command: "bd prime --hook-json" },
  // Records the session against its track, so a message reaches it while it runs.
  { event: "SessionStart", matcher: "", command: mshapeCommand(["msg", "register"]) },
  // The track's unread mail, at session start and at every prompt, until it is read.
  { event: "SessionStart", matcher: "", command: mshapeCommand(["msg", "inbox", "--quiet"]) },
  { event: "UserPromptSubmit", matcher: "", command: mshapeCommand(["msg", "inbox", "--quiet"]) },
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
 * `settings` with each missing hook appended under its event, and everything else, the repo's
 * own hooks included, kept: for a repo whose settings.json monkeyshape doesn't own whole.
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
    added[event] = [...hookEntries(settings, event), ...entries];
  return `${JSON.stringify({ ...settings, hooks: added }, null, 2)}\n`;
};
