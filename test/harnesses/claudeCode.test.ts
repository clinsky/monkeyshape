import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { hookCommand, LOOP_HOOKS } from "../../src/core/hooks.ts";
import { REGISTRATION_GRACE_MS } from "../../src/core/notices.ts";
import {
  CLAUDE_HOOKS,
  type ClaudeSession,
  claudeCode,
  claudeOwns,
  claudeStatus,
  claudeTarget,
  decodeClaudeKey,
  decodeClaudeSession,
  sessionsIn,
  socketPayload,
} from "../../src/harnesses/claude-code/index.ts";
import type { Registration } from "../../src/harnesses/harness.ts";

const ID = "eb83488f-048b-46d7-8379-6b651938a992";
const registration: Registration = {
  harness: "claude-code",
  session: ID,
  pid: 42,
  registered: "2026-11-03T14:00:00.000Z",
};
/** An hour after registering: long past the grace a new registration gets. */
const NOW = new Date("2026-11-03T15:00:00.000Z");
const session: ClaudeSession = {
  pid: 42,
  sessionId: ID,
  procStart: "100",
  peerProtocol: 1,
  messagingSocketPath: "/run/s.sock",
};
const key = { peerToken: "secret", procStart: "100" };
const leftover = { peerToken: "old", procStart: "7" };
const other = { ...session, sessionId: "00000000-0000-0000-0000-000000000000" };

describe("Claude Code: sessions", () => {
  test("a live session's notice goes to its own socket, with its own process's key", () => {
    expect(claudeTarget(session, [leftover, key, leftover])).toEqual({
      socket: "/run/s.sock",
      token: "secret",
    });
  });

  test("a gone session, or another session in the pid (a /clear, a reused pid), is gone", () => {
    expect(claudeStatus(registration, undefined, NOW)).toEqual({
      kind: "gone",
      reason: "its Claude Code session has ended",
    });
    expect(claudeStatus(registration, other, NOW)).toEqual({
      kind: "gone",
      reason: "its process now runs another session",
    });
    expect(claudeStatus(registration, session, NOW)).toEqual({ kind: "live" });
  });

  test("a registration ahead of Claude Code's record is pending for a grace period, then gone", () => {
    const at = (ms: number) => new Date(Date.parse(registration.registered) + ms);
    for (const record of [undefined, other]) {
      expect(claudeStatus(registration, record, at(5_000))).toEqual({ kind: "pending" });
      expect(claudeStatus(registration, record, at(REGISTRATION_GRACE_MS)).kind).toBe("gone");
    }
  });

  test("sessionsIn: the worktree itself and anything under it, never a sibling", () => {
    const at = (n: number, cwd?: string): ClaudeSession => ({
      ...session,
      sessionId: `s${n}`,
      ...(cwd === undefined ? {} : { cwd }),
    });
    const records = [at(1, "/r/wt@a"), at(2, "/r/wt@a/src"), at(3, "/r/wt@ab"), at(4)];
    expect(sessionsIn("/r/wt@a", records)).toEqual(["s1", "s2"]);
  });

  test("an unknown protocol or a missing or stale key gives a reason, never a target", () => {
    expect(claudeTarget({ ...session, peerProtocol: 2 }, [key])).toEqual({
      reason: "Claude Code speaks messaging protocol 2; this mshape knows 1",
    });
    expect(claudeTarget(session, [])).toEqual({ reason: "Claude Code published no key for it" });
    expect("reason" in claudeTarget(session, [leftover])).toBe(true);
  });

  test("records decode strictly enough that a notice can't go to a half-read session", () => {
    expect(decodeClaudeSession(JSON.stringify({ ...session, extra: 1 }))).toEqual(session);
    expect(decodeClaudeSession(JSON.stringify({ ...session, peerProtocol: "1" }))).toBeUndefined();
    expect(decodeClaudeKey("{")).toBeUndefined();
  });

  test("the socket reads an auth line, then the notice as a user message", () => {
    const line = "[mshape] Message from tracks: x (mshape msg read 1)";
    const [auth, user, end] = socketPayload("tok", line).split("\n");
    expect(JSON.parse(auth ?? "")).toEqual({ type: "auth", token: "tok" });
    expect(JSON.parse(user ?? "")).toEqual({
      type: "user",
      message: { role: "user", content: line },
    });
    expect(end).toBe("");
  });
});

describe("Claude Code: identity", () => {
  const identify = (env: Record<string, string>, hookInput?: string) =>
    claudeCode.identify({ env, ...(hookInput === undefined ? {} : { hookInput }) });

  test("the hook's session_id first, then CLAUDE_CODE_SESSION_ID; the pid from CLAUDE_PID", () => {
    const hook = JSON.stringify({ session_id: ID, hook_event_name: "SessionStart" });
    expect(identify({ CLAUDE_CODE_SESSION_ID: other.sessionId, CLAUDE_PID: "42" }, hook)).toEqual({
      harness: "claude-code",
      session: ID,
      pid: 42,
    });
    expect(identify({ CLAUDE_CODE_SESSION_ID: ID })).toEqual({
      harness: "claude-code",
      session: ID,
    });
    expect(identify({ CLAUDE_PID: "42" })).toEqual({ harness: "claude-code", pid: 42 });
  });

  test("nothing, empty variables or a malformed id claim nothing", () => {
    expect(identify({})).toBeUndefined();
    expect(
      identify({ CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "", CODEX_THREAD_ID: "" }),
    ).toBeUndefined();
    expect(identify({ CLAUDE_CODE_SESSION_ID: "../x", CLAUDE_PID: "-1" })).toBeUndefined();
    expect(identify({}, "not json")).toBeUndefined();
  });

  test("a skill is started with a slash", () => {
    expect(claudeCode.invoke("track")).toBe("/track");
    expect(claudeCode.invoke("track", "harness")).toBe("/track harness");
  });
});

describe("Claude Code: the hooks it delivers", () => {
  const settingsFile = () => {
    const [file] = claudeCode.files(LOOP_HOOKS);
    if (file?.kind !== "owned-entries") throw new Error("Claude Code's settings are owned entries");
    return file;
  };

  test("a loop command dropped in a later release is removed by sync, and check names it (iwf)", () => {
    // What a release's prompt hook would look like if it ran `msg watch`, and the next release
    // dropped it: no loop command renders it now, as none will for a dropped one.
    const gone = hookCommand(["--harness", "claude-code", "msg", "watch"]);
    const before = JSON.parse(settingsFile().merge(undefined));
    before.hooks.UserPromptSubmit.push(
      { matcher: "", hooks: [{ type: "command", command: gone }] },
      { matcher: "", hooks: [{ type: "command", command: "echo mine" }] },
    );
    const file = settingsFile();
    expect(file.missing(before)).toEqual([
      `still runs UserPromptSubmit: \`${gone}\`, which monkeyshape no longer ships`,
    ]);
    const after = JSON.parse(file.merge(before));
    expect(
      after.hooks.UserPromptSubmit.map(
        (entry: { hooks: Array<{ command: string }> }) => entry.hooks[0]?.command,
      ),
    ).toEqual([CLAUDE_HOOKS[1]?.command, "echo mine"]);
    expect(file.missing(after)).toEqual([]);
  });

  test("every command any released version wrote is recognised as monkeyshape's", async () => {
    // A fixture per release's rendered settings: dropping a command without recognising it
    // would leave it in every repo, so this goes red instead.
    for (const release of ["0.6", "0.7"]) {
      const fixture = await Bun.file(
        join(import.meta.dir, "..", "fixtures", `settings-${release}.json`),
      ).json();
      const commands = Object.values(
        fixture.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>,
      )
        .flat()
        .flatMap((entry) => entry.hooks.map((hook) => hook.command));
      expect(commands.length).toBeGreaterThan(0);
      for (const command of commands)
        expect([release, claudeOwns(command)]).toEqual([release, true]);
    }
  });

  test("a repo's own hook is never taken for monkeyshape's", () => {
    for (const command of ["echo mine", "mshape prime", "bd prime", "mshape --harness codex prime"])
      expect(claudeOwns(command)).toBe(false);
  });
});
