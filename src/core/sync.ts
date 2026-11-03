/**
 * What `mshape sync` keeps in step with the installed monkeyshape, beside the shared skills:
 * `.beads/PRIME.md`, the PR template, and monkeyshape's hooks in `.claude/settings.json`.
 * Planning is pure; the adapter writes. The `sync` check holds a repo to the same plan, so a
 * hand edit or a missing hook fails the gate with the fix: run sync.
 *
 * Only a repo sync manages is checked: one with the shared-skills manifest, which `mshape init`
 * and `mshape sync` write. A repo that adopted monkeyshape's checks alone has none, and passes.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { PR_TEMPLATE_FILE, PRIME_FILE, prTemplate } from "./conventions.ts";
import { addHooks, HOOKS, type Hook, missingHooks, SETTINGS_FILE, SYNC_COMMAND } from "./hooks.ts";
import { SKILLS_MANIFEST } from "./layout.ts";
import type { Snapshot, Violation } from "./model.ts";

/** Every rule this check reports, as `sync/<kind>`; test/core/ruleCases.test.ts covers each. */
export const SYNC_RULES = [
  "prime-missing",
  "prime-diverged",
  "pr-template-missing",
  "pr-template-diverged",
  "hook-missing",
  "settings-invalid",
  "ignored",
] as const;

const violation = (
  rule: (typeof SYNC_RULES)[number],
  file: string,
  message: string,
): Violation => ({
  check: "sync",
  rule: `sync/${rule}`,
  file,
  message,
});

const SYNC = `\`${SYNC_COMMAND}\``;

/** The files sync writes besides the skills: each must be committed to reach other clones. */
export const SYNCED_FILES: ReadonlyArray<string> = [PRIME_FILE, PR_TEMPLATE_FILE, SETTINGS_FILE];

const ignoredMessage = (file: string): string =>
  `is on disk but ignored by git, so it isn't committed and other clones and CI don't have it${file === SETTINGS_FILE ? ": their sessions run none of its hooks" : ""}. \`${SYNC_COMMAND}\` can't fix that. Find the rule with \`git check-ignore -v ${file}\`, unignore the file (for \`.claude/\`, use \`.claude/*\` plus \`!${file}\`), then \`git add ${file}\` and commit it.`;

/** What sync reads of a repo. */
export interface SyncState {
  /** Synced files on disk that git ignores: sync can't make them reach other clones. */
  readonly ignored: ReadonlyArray<string>;
  /** Whether the repo uses beads: anything under `.beads/`. */
  readonly beads: boolean;
  readonly prime: string | undefined;
  readonly prTemplate: string | undefined;
  /** `.claude/settings.json`'s text, if it exists. */
  readonly settings: string | undefined;
}

/** The parsed settings, `{}` for none, undefined when it isn't a JSON object. */
const parseSettings = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

export interface SyncPlan {
  /** Repo-relative path to its new text: only files that change. */
  readonly write: ReadonlyMap<string, string>;
  /** What sync left alone, and why, one line each: for information. */
  readonly notes: ReadonlyArray<string>;
  /** What sync couldn't do and `mshape check` will still fail on: sync exits 1. */
  readonly blocked: ReadonlyArray<string>;
}

/** What it takes to bring a repo's synced files up to `shippedPrime` and this package's code. */
export const planSync = (state: SyncState, shippedPrime: string): SyncPlan => {
  const write = new Map<string, string>();
  const notes: Array<string> = [];
  const blocked = state.ignored.map((file) => `${file} ${ignoredMessage(file)}`);
  if (state.beads) {
    if (state.prime !== shippedPrime) write.set(PRIME_FILE, shippedPrime);
  } else
    notes.push(
      `${PRIME_FILE}: not installed, since this repo has no .beads/ yet; run \`bd init\`, then sync again`,
    );
  if (state.prTemplate !== prTemplate()) write.set(PR_TEMPLATE_FILE, prTemplate());
  const settings = parseSettings(state.settings);
  if (settings === undefined)
    blocked.push(
      `${SETTINGS_FILE}: left alone, since it isn't a JSON object; fix it, then sync again`,
    );
  else if (missingHooks(settings, HOOKS).length > 0)
    write.set(SETTINGS_FILE, addHooks(settings, HOOKS));
  return { write, notes, blocked };
};

/** One line per file sync wrote, for the CLI. */
export const formatSyncPlan = (plan: SyncPlan): ReadonlyArray<string> => [
  ...[...plan.write.keys()].map((path) => `${path}: updated`),
  ...plan.notes,
  ...plan.blocked,
];

const describe = (hook: Hook): string => `${hook.event}: \`${hook.command}\``;

/**
 * A synced repo's PRIME.md and PR template match what this monkeyshape ships, and its
 * settings.json runs every monkeyshape hook. Its own hooks and settings are its business.
 */
export const checkSync = (
  _config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  if (!snapshot.skills.installed.has(SKILLS_MANIFEST)) return [];
  const out: Array<Violation> = [...snapshot.unlisted]
    .filter((file) => SYNCED_FILES.includes(file))
    .map((file) => violation("ignored", file, ignoredMessage(file)));
  // An ignored file is reported once, as ignored: "missing" would prescribe sync, which can't help.
  const prime = snapshot.unlisted.has(PRIME_FILE) ? undefined : snapshot.texts.get(PRIME_FILE);
  const beads = snapshot.files.some((file) => file.startsWith(".beads/"));
  if (beads && snapshot.shippedPrime !== undefined && !snapshot.unlisted.has(PRIME_FILE)) {
    if (prime === undefined)
      out.push(
        violation(
          "prime-missing",
          PRIME_FILE,
          `is missing, so bd's SessionStart hook prints bd's default text, which contradicts this repo's conventions (agents push, beads close when their PR merges). Run ${SYNC} and commit it.`,
        ),
      );
    else if (prime !== snapshot.shippedPrime)
      out.push(
        violation(
          "prime-diverged",
          PRIME_FILE,
          `differs from the copy the installed monkeyshape ships. It holds what monkeyshape decides; what this repo decides goes in AGENTS.md. Move any local change there, then run ${SYNC} and commit it.`,
        ),
      );
  }
  const template = snapshot.texts.get(PR_TEMPLATE_FILE);
  if (snapshot.unlisted.has(PR_TEMPLATE_FILE)) {
    // Reported above as ignored.
  } else if (template === undefined)
    out.push(
      violation(
        "pr-template-missing",
        PR_TEMPLATE_FILE,
        `is missing, so PRs here have no sections to fill and CI's PR check has nothing to match. Run ${SYNC} and commit it.`,
      ),
    );
  else if (template !== prTemplate())
    out.push(
      violation(
        "pr-template-diverged",
        PR_TEMPLATE_FILE,
        `differs from the template the installed monkeyshape renders from its PR sections, which \`mshape track pr\` and CI's PR check use too. Run ${SYNC} and commit it.`,
      ),
    );
  const settings = parseSettings(snapshot.texts.get(SETTINGS_FILE));
  if (snapshot.unlisted.has(SETTINGS_FILE)) {
    // Reported above as ignored.
  } else if (settings === undefined)
    out.push(
      violation(
        "settings-invalid",
        SETTINGS_FILE,
        `isn't a JSON object, so Claude Code runs none of its hooks. Fix the JSON, then run ${SYNC}.`,
      ),
    );
  else {
    const missing = missingHooks(settings, HOOKS);
    if (missing.length > 0)
      out.push(
        violation(
          "hook-missing",
          SETTINGS_FILE,
          `doesn't run ${missing.map(describe).join("; ")}. Without them a session misses the conventions or its track's mail at start. Run ${SYNC}, which adds them and keeps your own hooks, and commit it.`,
        ),
      );
  }
  return out;
};
