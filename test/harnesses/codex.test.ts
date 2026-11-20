import { describe, expect, test } from "bun:test";
import { PRIME_FALLBACK } from "../../src/core/hooks.ts";
import { codex, codexCommand, mergeHooks, missingHooks } from "../../src/harnesses/codex/index.ts";
import type { JsonObject, LoopHook } from "../../src/harnesses/harness.ts";

const HOOKS: ReadonlyArray<LoopHook> = [
  { moment: "session-start", args: ["prime"] },
  { moment: "prompt", args: ["msg", "inbox", "--quiet"] },
];

const parse = (text: string): JsonObject => JSON.parse(text) as JsonObject;

const commands = (file: JsonObject, event: string): ReadonlyArray<string> =>
  (
    ((file["hooks"] as Record<string, unknown>)[event] ?? []) as Array<{
      hooks: Array<{ command: string }>;
    }>
  ).flatMap((entry) => entry.hooks.map((hook) => hook.command));

const repoHook = { hooks: [{ type: "command", command: "./scripts/fmt-check.sh" }] };

describe("codex hooks.json", () => {
  test("a new file runs prime at session start and the inbox at each prompt, each with --harness codex", () => {
    const file = parse(mergeHooks(undefined, HOOKS));
    expect(commands(file, "SessionStart")).toEqual([codexCommand(["prime"])]);
    expect(commands(file, "UserPromptSubmit")).toEqual([codexCommand(["msg", "inbox", "--quiet"])]);
    expect(codexCommand(["prime"])).toContain("mshape --harness codex prime");
    expect(missingHooks(file, HOOKS)).toEqual([]);
  });

  test("commands carry no version and no absolute path, so trust survives an upgrade", () => {
    const command = codexCommand(["prime"]);
    expect(command).not.toMatch(/\d+\.\d+\.\d+/);
    expect(command).not.toContain("/home/");
    expect(command).toContain("$HOME/.local/bin");
  });

  test("prime falls back to bd's primer where mshape can't run; the inbox doesn't", () => {
    expect(codexCommand(["prime"])).toContain(PRIME_FALLBACK);
    expect(codexCommand(["msg", "inbox", "--quiet"])).not.toContain(PRIME_FALLBACK);
  });

  test("the repo's hooks and keys are kept, and ours are appended after theirs", () => {
    const current = { model: "x", hooks: { SessionStart: [repoHook], Stop: [repoHook] } };
    const file = parse(mergeHooks(current, HOOKS));
    expect(file["model"]).toBe("x");
    expect(commands(file, "SessionStart")).toEqual([
      "./scripts/fmt-check.sh",
      codexCommand(["prime"]),
    ]);
    expect(commands(file, "Stop")).toEqual(["./scripts/fmt-check.sh"]);
  });

  test("a file already in step is left as it is, even with a repo hook added after ours", () => {
    const merged = parse(mergeHooks(undefined, HOOKS));
    const hooks = merged["hooks"] as Record<string, Array<unknown>>;
    const edited = {
      ...merged,
      hooks: { ...hooks, SessionStart: [...(hooks["SessionStart"] ?? []), repoHook] },
    };
    expect(parse(mergeHooks(edited, HOOKS))).toEqual(edited);
    expect(mergeHooks(merged, HOOKS)).toBe(mergeHooks(undefined, HOOKS));
  });

  test("a stale command of ours is replaced in its slot, and the check names it until then", () => {
    const stale = codexCommand(["msg", "register"]);
    const current = {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: stale }] }, repoHook] },
    };
    expect(missingHooks(current, HOOKS)).toEqual([
      `SessionStart: ${codexCommand(["prime"])}`,
      `UserPromptSubmit: ${codexCommand(["msg", "inbox", "--quiet"])}`,
    ]);
    const file = parse(mergeHooks(current, HOOKS));
    expect(commands(file, "SessionStart")).toEqual([
      codexCommand(["prime"]),
      "./scripts/fmt-check.sh",
    ]);
  });

  test("ours in the wrong order is named, and fixed by the merge", () => {
    const two: ReadonlyArray<LoopHook> = [
      { moment: "session-start", args: ["prime"] },
      { moment: "session-start", args: ["msg", "inbox"] },
    ];
    const swapped = parse(mergeHooks(undefined, [...two].reverse()));
    expect(missingHooks(swapped, two)).toEqual([
      "SessionStart: monkeyshape's hooks are stale or out of order",
    ]);
    expect(missingHooks(parse(mergeHooks(swapped, two)), two)).toEqual([]);
  });

  test("merging no hooks removes every one of ours, and keeps the repo's", () => {
    const current = parse(mergeHooks({ hooks: { SessionStart: [repoHook] } }, HOOKS));
    const file = parse(mergeHooks(current, []));
    expect(file["hooks"]).toEqual({ SessionStart: [repoHook] });
    expect(missingHooks(current, [])).toEqual([
      "SessionStart: a hook monkeyshape no longer ships",
      "UserPromptSubmit: a hook monkeyshape no longer ships",
    ]);
  });

  test("one entry holding a repo hook and one of ours keeps the repo's", () => {
    const mixed = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "./x.sh" },
              { type: "command", command: codexCommand(["old"]) },
            ],
          },
        ],
      },
    };
    const file = parse(mergeHooks(mixed, HOOKS));
    expect(commands(file, "SessionStart")).toEqual(["./x.sh", codexCommand(["prime"])]);
  });

  test("delivered as owned entries of .codex/hooks.json, with what the human must do after", () => {
    const [file] = codex.files(HOOKS);
    expect(file?.kind).toBe("owned-entries");
    expect(file?.path).toBe(".codex/hooks.json");
    expect(codex.afterDelivery).toContain("trust");
    expect(codex.afterDelivery).toContain("main checkout");
  });
});

const SESSION = "01a1f52f-294a-7841-895f-4674a4801241";

const hookInput = (fields: Record<string, unknown>) =>
  JSON.stringify({ session_id: SESSION, hook_event_name: "SessionStart", cwd: "/r", ...fields });

describe("codex identify", () => {
  test("a hook run with --harness codex: the session_id", () => {
    expect(codex.identify({ harness: "codex", env: {}, hookInput: hookInput({}) })).toEqual({
      harness: "codex",
      session: SESSION,
    });
  });

  test("a hook without the flag: never claimed, even with Codex's transcript (0.6's are Claude Code's)", () => {
    const transcript = `/h/.codex/sessions/2026/11/19/rollout-2026-11-19T13-57-46-${SESSION}.jsonl`;
    expect(
      codex.identify({ env: {}, hookInput: hookInput({ transcript_path: transcript }) }),
    ).toBeUndefined();
    expect(codex.identify({ env: {}, hookInput: hookInput({}) })).toBeUndefined();
  });

  test("another harness named: never Codex's, whatever leaked into the environment", () => {
    expect(
      codex.identify({
        harness: "claude-code",
        env: { CODEX_THREAD_ID: SESSION },
        hookInput: hookInput({}),
      }),
    ).toBeUndefined();
  });

  test("a command the agent runs: CODEX_THREAD_ID", () => {
    expect(codex.identify({ env: { CODEX_THREAD_ID: SESSION } })).toEqual({
      harness: "codex",
      session: SESSION,
    });
  });

  test("nothing Codex's, or an id that isn't a safe file name: nothing", () => {
    expect(codex.identify({ env: { CLAUDE_CODE_SESSION_ID: "abc" } })).toBeUndefined();
    expect(codex.identify({ env: { CODEX_THREAD_ID: "../x" } })).toBeUndefined();
    expect(codex.identify({ harness: "codex", env: {}, hookInput: "not json" })).toBeUndefined();
  });
});

describe("codex skills", () => {
  test("read natively from .agents/skills, started as $<skill>", () => {
    expect(codex.skills).toEqual({ kind: "native" });
    expect(codex.invoke("track", "codex")).toBe("$track codex");
    expect(codex.invoke("handoff")).toBe("$handoff");
  });
});

describe("codex hooks.json in a repo that doesn't list codex", () => {
  test("a file with nothing of ours is left exactly as it is", () => {
    for (const current of [
      { model: "x" },
      { hooks: { Stop: [] } },
      { hooks: { SessionStart: [repoHook], Stop: [] } },
      { hooks: "not an object" },
    ])
      expect(parse(mergeHooks(current, []))).toEqual(current);
  });

  test("ours removed, the repo's empty events kept", () => {
    const current = parse(mergeHooks({ hooks: { Stop: [] } }, HOOKS));
    expect(parse(mergeHooks(current, []))).toEqual({ hooks: { Stop: [] } });
  });
});

describe("codex hooks.json: review of #151", () => {
  test("a stale hook of ours between the repo's is replaced in its slot, so theirs keep their indices", () => {
    const current = {
      hooks: {
        SessionStart: [
          repoHook,
          { hooks: [{ type: "command", command: codexCommand(["old"]) }] },
          repoHook,
        ],
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: codexCommand(["msg", "inbox", "--quiet"]) }] },
        ],
      },
    };
    const file = parse(mergeHooks(current, HOOKS));
    expect(commands(file, "SessionStart")).toEqual([
      "./scripts/fmt-check.sh",
      codexCommand(["prime"]),
      "./scripts/fmt-check.sh",
    ]);
    expect(missingHooks(file, HOOKS)).toEqual([]);
  });

  test("a repo's own hook that runs mshape --harness codex isn't ours: kept, and never counted", () => {
    const own = "mshape --harness codex msg send main --subject started started";
    const wrapped = codexCommand(["msg", "send", "main", "hi"]).replace(
      "could not run here",
      "failed",
    );
    const current = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: own }] },
          { hooks: [{ type: "command", command: wrapped }] },
        ],
      },
    };
    const file = parse(mergeHooks(current, HOOKS));
    expect(commands(file, "SessionStart")).toEqual([own, wrapped, codexCommand(["prime"])]);
    expect(parse(mergeHooks(file, []))).toEqual(current);
  });

  test("ours with a quoted argument is still ours", () => {
    const quoted: ReadonlyArray<LoopHook> = [
      { moment: "session-start", args: ["msg", "send", "main", "it's here"] },
    ];
    const file = parse(mergeHooks(undefined, quoted));
    expect(commands(file, "SessionStart")[0]).toContain(`'it'\\''s here'`);
    expect(missingHooks(file, quoted)).toEqual([]);
    expect(parse(mergeHooks(file, []))).toEqual({ hooks: {} });
  });
});
