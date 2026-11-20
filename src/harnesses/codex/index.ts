/**
 * Codex's adapter, its pure part: `.codex/hooks.json`, the session a command runs in, and how
 * a human starts a skill. Facts as tested on codex-cli 0.170.0:
 *
 * - Codex reads `.codex/hooks.json` (Claude Code's shape) only once the human trusts the
 *   project, then each hook, by its file, event, position and a hash of its text; a changed
 *   or moved hook is asked about again. In a git worktree it runs the main checkout's file.
 * - Hook stdin carries `session_id`, the id `codex queue --thread` takes. Hooks don't get
 *   `CODEX_THREAD_ID`; the agent's tool shells do.
 * - Skills are read from `.agents/skills`; a human names one as `$<skill>`.
 */

import { hookCommand, PRIME_FALLBACK } from "../../core/hooks.ts";
import type {
  Harness,
  HarnessFile,
  Identity,
  Invocation,
  JsonObject,
  LoopHook,
  Moment,
} from "../harness.ts";
import { SESSION_KEY } from "../harness.ts";

/** Where Codex reads a project's hooks, repo-relative. */
export const HOOKS_FILE = ".codex/hooks.json";

const EVENTS: Readonly<Record<Moment, string>> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
};

/** The flag every command this adapter renders carries, so the core asks only Codex. */
const FLAG = ["--harness", "codex"] as const;

/**
 * A hook command as delivered: byte-stable across versions, so trust survives an upgrade.
 * `prime` falls back to bd's primer where mshape can't run, as Claude Code's does.
 */
export const codexCommand = (args: ReadonlyArray<string>): string =>
  hookCommand([...FLAG, ...args], args[0] === "prime" ? PRIME_FALLBACK : undefined);

/** The arguments of a command line as `mshapeCommand` quotes them (POSIX single quotes). */
const unquote = (line: string): ReadonlyArray<string> =>
  [...line.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)].map(
    ([, quoted, bare]) => quoted?.replaceAll("'\\''", "'") ?? bare ?? "",
  );

/**
 * Whether `command` is one this adapter rendered: exactly `codexCommand` of the arguments it
 * runs. A repo's own hook that runs `mshape --harness codex ...` some other way is the repo's.
 * A version that changes how commands are rendered must keep recognising the old ones here.
 */
const ours = (command: unknown): boolean => {
  if (typeof command !== "string") return false;
  const start = command.indexOf(`mshape ${FLAG.join(" ")} `);
  if (start < 0) return false;
  const rest = command.slice(start + `mshape ${FLAG.join(" ")} `.length);
  const end = rest.indexOf(" ||");
  if (end < 0) return false;
  return command === codexCommand(unquote(rest.slice(0, end)));
};

type Entry = {
  readonly hooks: ReadonlyArray<{ readonly type: "command"; readonly command: string }>;
};

const entry = (command: string): Entry => ({ hooks: [{ type: "command", command }] });

/** Each event's entries, as monkeyshape renders them for `hooks`. */
const wanted = (hooks: ReadonlyArray<LoopHook>): ReadonlyMap<string, ReadonlyArray<string>> => {
  const events = new Map<string, Array<string>>();
  for (const hook of hooks) {
    const event = EVENTS[hook.moment];
    events.set(event, [...(events.get(event) ?? []), codexCommand(hook.args)]);
  }
  return events;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const commandsOf = (value: unknown): ReadonlyArray<unknown> =>
  isObject(value) && Array.isArray(value["hooks"])
    ? value["hooks"].map((inner) => (isObject(inner) ? inner["command"] : undefined))
    : [];

/** The commands of ours an event's entries run, in order. */
const oursIn = (entries: ReadonlyArray<unknown>): ReadonlyArray<string> =>
  entries.flatMap((value) => commandsOf(value).filter(ours) as Array<string>);

/**
 * An event's entries with ours made `commands`: each of ours rewritten in its own slot, in
 * order, so the repo's entries keep their indices (Codex's trust key); ours left over are
 * taken out (an entry left with no hook goes too), and commands left over are appended.
 */
const replaceOurs = (
  entries: ReadonlyArray<unknown>,
  commands: ReadonlyArray<string>,
): Array<unknown> => {
  const queue = [...commands];
  const out = entries.flatMap((value) => {
    if (!isObject(value) || !Array.isArray(value["hooks"])) return [value];
    const inner = value["hooks"] as Array<unknown>;
    if (!inner.some((hook) => isObject(hook) && ours(hook["command"]))) return [value];
    const kept = inner.flatMap((hook) => {
      if (!(isObject(hook) && ours(hook["command"]))) return [hook];
      const next = queue.shift();
      return next === undefined ? [] : [{ ...hook, command: next }];
    });
    return kept.length === 0 ? [] : [{ ...value, hooks: kept }];
  });
  return [...out, ...queue.map(entry)];
};

const sameList = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * `.codex/hooks.json` with monkeyshape's entries made exactly `hooks`, everything else kept.
 * An event whose entries of ours are already right is left as it is, so nothing moves and no
 * hook is asked about again; otherwise ours are rewritten in their slots and new ones appended
 * after the repo's, never reordering theirs (`replaceOurs`).
 */
export const mergeHooks = (
  current: JsonObject | undefined,
  hooks: ReadonlyArray<LoopHook>,
): string => {
  const want = wanted(hooks);
  const render = (value: JsonObject) => `${JSON.stringify(value, null, 2)}\n`;
  const raw = current?.["hooks"];
  // Nothing to add, and no hooks of anyone's to take ours from: the file stays as it is.
  if (want.size === 0 && !isObject(raw)) return render(current ?? {});
  const existing = isObject(raw) ? raw : {};
  const events: Record<string, unknown> = {};
  for (const event of new Set([...Object.keys(existing), ...want.keys()])) {
    const value = existing[event];
    const entries: ReadonlyArray<unknown> = Array.isArray(value) ? value : [];
    const commands = want.get(event) ?? [];
    if (value !== undefined && (!Array.isArray(value) || sameList(oursIn(entries), commands)))
      events[event] = value;
    else {
      // An event left empty only by taking ours out goes with them.
      const kept = replaceOurs(entries, commands);
      if (kept.length > 0) events[event] = kept;
    }
  }
  return render({ ...current, hooks: events });
};

/** What `current` lacks of `hooks`, one line per hook: empty when in step. */
export const missingHooks = (
  current: JsonObject | undefined,
  hooks: ReadonlyArray<LoopHook>,
): ReadonlyArray<string> => {
  const existing = isObject(current?.["hooks"])
    ? (current["hooks"] as Record<string, unknown>)
    : {};
  const lacks: Array<string> = [];
  for (const [event, commands] of wanted(hooks)) {
    const raw = existing[event];
    const have = oursIn(Array.isArray(raw) ? raw : []);
    if (sameList(have, commands)) continue;
    const absent = commands.filter((command) => !have.includes(command));
    lacks.push(
      ...(absent.length > 0
        ? absent.map((command) => `${event}: ${command}`)
        : [`${event}: monkeyshape's hooks are stale or out of order`]),
    );
  }
  // An event monkeyshape no longer hooks, still running one of ours.
  for (const [event, raw] of Object.entries(existing))
    if (!wanted(hooks).has(event) && Array.isArray(raw) && oursIn(raw).length > 0)
      lacks.push(`${event}: a hook monkeyshape no longer ships`);
  return lacks;
};

/**
 * A hook's `session_id`, only when the hook said it is Codex's (`--harness codex`): hook
 * inputs look alike across harnesses, and an unflagged one (Claude Code's 0.6 hooks) is
 * Claude Code's to claim, so claiming it too would make it ambiguous.
 */
const fromHook = (invocation: Invocation): string | undefined => {
  if (invocation.harness !== "codex" || invocation.hookInput === undefined) return undefined;
  let input: unknown;
  try {
    input = JSON.parse(invocation.hookInput);
  } catch {
    return undefined;
  }
  return isObject(input) && typeof input["session_id"] === "string"
    ? input["session_id"]
    : undefined;
};

/**
 * The session running this command: a Codex hook's `session_id`, else the `CODEX_THREAD_ID`
 * Codex sets in the agent's shells. Nothing when neither is there or the id isn't a
 * filename-safe key.
 */
export const identify = (invocation: Invocation): Identity | undefined => {
  if (invocation.harness !== undefined && invocation.harness !== "codex") return undefined;
  const session = fromHook(invocation) ?? invocation.env["CODEX_THREAD_ID"];
  return session !== undefined && SESSION_KEY.test(session)
    ? { harness: "codex", session }
    : undefined;
};

const AFTER_DELIVERY =
  "Codex runs these hooks only once you trust them: at Codex's next start, trust the project if it asks, then choose \"Trust all and continue\" for the hooks (asked again whenever a hook changes). Codex reads them from the main checkout, also in a track's worktree, so a change made in a track takes effect once it is merged and pulled there.";

export const codex: Harness = {
  id: "codex",
  name: "Codex",
  moments: ["session-start", "prompt"],
  files: (hooks): ReadonlyArray<HarnessFile> => [
    {
      kind: "owned-entries",
      path: HOOKS_FILE,
      merge: (current) => mergeHooks(current, hooks),
      missing: (current) => missingHooks(current, hooks),
    },
  ],
  afterDelivery: AFTER_DELIVERY,
  skills: { kind: "native" },
  identify,
  invoke: (skill, args) => (args === undefined || args === "" ? `$${skill}` : `$${skill} ${args}`),
  identifiedBy: "a Codex hook's session_id (run with --harness codex), or CODEX_THREAD_ID",
};
