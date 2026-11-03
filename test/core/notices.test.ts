import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/core/mail.ts";
import {
  type ClaudeSession,
  decodeClaudeKey,
  decodeClaudeSession,
  decodeRegistration,
  encodeRegistration,
  formatDelivery,
  noticeLine,
  planNotice,
  type Registration,
  socketPayload,
} from "../../src/core/notices.ts";

const ID = "eb83488f-048b-46d7-8379-6b651938a992";
const registration: Registration = { session: ID, pid: 42, registered: "t" };
const session: ClaudeSession = {
  pid: 42,
  sessionId: ID,
  procStart: "100",
  peerProtocol: 1,
  messagingSocketPath: "/run/s.sock",
};
const key = { peerToken: "secret", procStart: "100" };
const leftover = { peerToken: "old", procStart: "7" };

describe("notices", () => {
  test("a live session of the registered process is notified, with its own socket and key", () => {
    expect(planNotice(registration, session, [leftover, key, leftover])).toEqual({
      kind: "notify",
      target: { session: ID, socket: "/run/s.sock", token: "secret" },
    });
  });

  test("a gone session, or another session in the pid (a /clear, a reused pid), is pruned", () => {
    expect(planNotice(registration, undefined, [key]).kind).toBe("prune");
    const other = { ...session, sessionId: "00000000-0000-0000-0000-000000000000" };
    expect(planNotice(registration, other, [key]).kind).toBe("prune");
  });

  test("an unknown protocol or a missing or stale key is skipped, not pruned", () => {
    const newer = planNotice(registration, { ...session, peerProtocol: 2 }, [key]);
    expect(newer).toEqual({
      kind: "skip",
      reason: "Claude Code speaks messaging protocol 2; this mshape knows 1",
    });
    expect(planNotice(registration, session, []).kind).toBe("skip");
    expect(planNotice(registration, session, [leftover]).kind).toBe("skip");
  });

  test("records decode strictly enough that a notice can't go to a half-read session", () => {
    expect(decodeRegistration(encodeRegistration(registration))).toEqual(registration);
    expect(
      decodeRegistration(JSON.stringify({ ...registration, session: "../x" })),
    ).toBeUndefined();
    expect(decodeClaudeSession(JSON.stringify({ ...session, extra: 1 }))).toEqual(session);
    expect(decodeClaudeSession(JSON.stringify({ ...session, peerProtocol: "1" }))).toBeUndefined();
    expect(decodeClaudeKey("{")).toBeUndefined();
  });

  test("the notice is one line naming the read command, never the body", () => {
    const message: Message = {
      id: "20261103-140000-0001",
      from: "tracks",
      to: "messaging",
      subject: "parser changed",
      body: "secret details",
      created: "2026-11-03T14:00:00.000Z",
    };
    const line = noticeLine(message);
    expect(line).toBe(
      "[mshape] Message from tracks: parser changed (bun run --silent mshape msg read 20261103-140000-0001)",
    );
    const [auth, user, end] = socketPayload("tok", line).split("\n");
    expect(JSON.parse(auth ?? "")).toEqual({ type: "auth", token: "tok" });
    expect(JSON.parse(user ?? "")).toEqual({
      type: "user",
      message: { role: "user", content: line },
    });
    expect(end).toBe("");
  });

  test("the sender is told who saw it, and where it waits otherwise", () => {
    expect(formatDelivery("docs", { notified: 2, pruned: [], skipped: [] })).toBe(
      "Notified 2 live sessions of docs.",
    );
    expect(formatDelivery("docs", { notified: 0, pruned: ["gone"], skipped: ["v2"] })).toBe(
      "No live session of docs to notify: they see it at their next session start or prompt.\nnote: pruned a registration of docs: gone\nnote: no notice to a session of docs: v2",
    );
  });
});
