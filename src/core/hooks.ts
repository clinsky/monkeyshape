/**
 * The Claude Code hooks a repo runs, and how a hook or a skill invokes `mshape`. `HOOKS` is the
 * one list: `.claude/settings.json`, in this repo and in every repo `mshape init` creates, is
 * `renderSettings(HOOKS)`, and a test fails when either file drifts from it. A new hook is one
 * entry here.
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

/** POSIX single quotes, only when needed: hook commands stay readable. */
const quote = (arg: string): string =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** Every hook, in the order each event runs them. */
export const HOOKS: ReadonlyArray<Hook> = [
  // bd's own: the beads primer, as hook JSON.
  { event: "SessionStart", matcher: "", command: "bd prime --hook-json" },
];

/** `.claude/settings.json`'s text for these hooks. */
export const renderSettings = (hooks: ReadonlyArray<Hook>): string => {
  const events: Record<string, Array<unknown>> = {};
  for (const hook of hooks)
    events[hook.event] = [
      ...(events[hook.event] ?? []),
      { matcher: hook.matcher, hooks: [{ type: "command", command: hook.command }] },
    ];
  return `${JSON.stringify({ hooks: events }, null, 2)}\n`;
};

/** Where Claude Code reads the project's hooks, repo-relative. */
export const SETTINGS_FILE = ".claude/settings.json";
