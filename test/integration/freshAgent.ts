/**
 * What a fresh agent actually loads at the start of a session: the output of the SessionStart
 * hooks, run exactly as the repo's `.claude/settings.json` configures them for a new session,
 * plus AGENTS.md and the `track` skill. Shared by the fresh-agent test and by anyone checking
 * an older commit by hand: `missingConventions(await sessionContext(dir))`.
 */
import { join } from "node:path";
import { GATE_COMMAND, PR_SIZE } from "../../src/core/conventions.ts";
import { SETTINGS_FILE } from "../../src/core/hooks.ts";

interface Entry {
  readonly matcher?: string;
  readonly hooks?: ReadonlyArray<{ readonly type?: string; readonly command?: string }>;
}

/** Whether a SessionStart matcher selects a new session (`startup`), as Claude Code reads it. */
const startsOn = (matcher: string | undefined): boolean =>
  matcher === undefined ||
  matcher === "" ||
  matcher === "*" ||
  new RegExp(`^(?:${matcher})$`).test("startup");

/** What a hook adds to the context: `additionalContext` from hook JSON, else its stdout. */
const contextOf = (stdout: string): string => {
  try {
    const parsed = JSON.parse(stdout);
    const added = parsed?.hookSpecificOutput?.additionalContext;
    if (typeof added === "string") return added;
  } catch {
    // Plain text: Claude Code adds a SessionStart hook's stdout as it is.
  }
  return stdout;
};

/**
 * The SessionStart hooks' context in `repo`, then AGENTS.md and the track skill. The hooks run
 * without Claude Code's session variables, so `msg register` records nothing.
 */
export const sessionContext = async (repo: string): Promise<string> => {
  const settings = await Bun.file(join(repo, SETTINGS_FILE)).json();
  const entries: ReadonlyArray<Entry> = settings?.hooks?.SessionStart ?? [];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("CLAUDE")),
  );
  const parts: Array<string> = [];
  for (const entry of entries.filter((e) => startsOn(e.matcher)))
    for (const hook of entry.hooks ?? []) {
      if (hook.type !== "command" || hook.command === undefined) continue;
      const ran = Bun.spawnSync(["sh", "-c", hook.command], {
        cwd: repo,
        env,
        stdin: new TextEncoder().encode(
          JSON.stringify({ hook_event_name: "SessionStart", source: "startup", cwd: repo }),
        ),
      });
      parts.push(contextOf(ran.stdout.toString()));
    }
  for (const file of ["AGENTS.md", ".agents/skills/track/SKILL.md"]) {
    const doc = Bun.file(join(repo, file));
    if (await doc.exists()) parts.push(await doc.text());
  }
  return parts.join("\n\n");
};

/** Each convention a fresh agent must be told, and how to tell that it was. */
export const CONVENTIONS: ReadonlyArray<{ readonly what: string; readonly said: RegExp }> = [
  {
    what: "the PR size",
    said: new RegExp(`${PR_SIZE.min}\\D{1,12}${PR_SIZE.max} changed lines`),
  },
  { what: "how to open a PR", said: /gh pr create --body-file/ },
  { what: "that agents push and open PRs", said: /[Aa]gents commit, push and open PRs/ },
  { what: "the gate", said: new RegExp(`\`${GATE_COMMAND}\` is the gate`) },
  { what: "the decision authority", said: /[Dd]ecision[- ]authority[\s\S]{0,200}maintainer/ },
  { what: "how to message another track", said: /mshape msg send <track>/ },
];

/** bd's default session text says this; it contradicts "agents push". */
const CONTRADICTION = /\bdo not push\b/i;

/** What `context` fails to say, or says against the conventions, one line each. */
export const missingConventions = (context: string): ReadonlyArray<string> => [
  ...CONVENTIONS.filter((c) => !c.said.test(context)).map((c) => `doesn't state ${c.what}`),
  ...(CONTRADICTION.test(context) ? [`says "${CONTRADICTION.exec(context)?.[0]}"`] : []),
];
