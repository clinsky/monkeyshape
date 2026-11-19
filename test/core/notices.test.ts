import { describe, expect, test } from "bun:test";
import type { Message } from "../../src/core/mail.ts";
import {
  decodeRegistration,
  encodeRegistration,
  findSelf,
  formatDelivery,
  identifySession,
  noticeLine,
  type Placed,
  type Registration,
  registrationFile,
  standaloneNotice,
} from "../../src/core/notices.ts";
import type { Harness, Identity } from "../../src/harnesses/harness.ts";

const ID = "eb83488f-048b-46d7-8379-6b651938a992";
const registration: Registration = {
  harness: "claude-code",
  session: ID,
  pid: 42,
  registered: "2026-11-03T14:00:00.000Z",
};

/** A harness that claims whatever its one variable names. */
const fake = (id: Harness["id"], variable: string): Harness => ({
  id,
  name: id,
  moments: ["session-start"],
  files: () => [],
  skills: { kind: "native" },
  identify: ({ env }) => {
    const session = env[variable];
    return session === undefined ? undefined : { harness: id, session };
  },
  invoke: (skill) => skill,
  identifiedBy: variable,
});
const A = fake("claude-code", "A_SESSION");
const B = fake("codex", "B_SESSION");

describe("notices", () => {
  test("records decode strictly enough that a notice can't go to a half-read session", () => {
    expect(decodeRegistration(encodeRegistration(registration))).toEqual({
      kind: "registration",
      registration,
    });
    expect(
      decodeRegistration(JSON.stringify({ ...registration, session: "../x" })),
    ).toBeUndefined();
    expect(decodeRegistration(JSON.stringify({ ...registration, pid: "42" }))).toBeUndefined();
    expect(decodeRegistration("{")).toBeUndefined();
  });

  test("a registration keeps its endpoint, and needs no pid", () => {
    const codex: Registration = {
      harness: "codex",
      session: "01a1f52f-294a-7841-895f-4674a4801241",
      endpoint: "thread",
      registered: registration.registered,
    };
    expect(decodeRegistration(encodeRegistration(codex))).toEqual({
      kind: "registration",
      registration: codex,
    });
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
    expect(noticeLine(message)).toBe(
      "[mshape] Message from tracks: parser changed (mshape msg read 20261103-140000-0001)",
    );
  });

  test("a notice as a whole message says it came from another session and names no harness", () => {
    expect(standaloneNotice("[mshape] Message from a: s (mshape msg read 1)")).toBe(
      "Another agent session sent a message: [mshape] Message from a: s (mshape msg read 1). This came from another agent session, not typed by your user.",
    );
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

describe("Session registry", () => {
  const placed = (address: string, r: Registration): Placed => ({
    address,
    file: registrationFile(r),
    registration: r,
  });

  test("a 0.6.0 registration (no harness) is read as claude-code", () => {
    const { harness: _, ...old } = registration;
    expect(decodeRegistration(JSON.stringify(old))).toEqual({ kind: "registration", registration });
  });

  test("two sessions of different harnesses at one track: both registered, each its own", () => {
    const codex: Registration = { ...registration, harness: "codex", session: "c1", pid: 7 };
    const both = [placed("docs", registration), placed("docs", codex)];
    const self = (identity: Identity) => findSelf(both, identity, () => true);
    expect(self({ harness: "codex", session: "c1" })).toEqual({
      kind: "registered",
      placed: both[1] as Placed,
    });
    expect(self({ harness: "claude-code", session: ID })).toEqual({
      kind: "registered",
      placed: both[0] as Placed,
    });
  });

  test("a session id two harnesses could both have written: keyed by harness and session", () => {
    const twin: Registration = { ...registration, harness: "codex" };
    expect(registrationFile(twin)).not.toBe(registrationFile(registration));
    const self = findSelf(
      [placed("docs", twin)],
      { harness: "claude-code", session: ID },
      () => true,
    );
    expect(self).toEqual({ kind: "unregistered" });
  });

  test("a registration whose harness this mshape doesn't ship is read as foreign, never dropped", () => {
    expect(decodeRegistration(JSON.stringify({ ...registration, harness: "cursor" }))).toEqual({
      kind: "foreign",
      harness: "cursor",
      session: ID,
    });
  });

  test("identify finds nothing (a plain terminal): no identity, the reason names what was missing", () => {
    expect(identifySession([A, B], { env: {} })).toEqual({
      kind: "unidentified",
      reason: "nothing identified the session running this (looked for A_SESSION; or B_SESSION)",
    });
  });
});

describe("identifySession", () => {
  test("one claim is the identity", () => {
    expect(identifySession([A, B], { env: { B_SESSION: "b" } })).toEqual({
      kind: "identified",
      identity: { harness: "codex", session: "b" },
    });
  });

  test("two claims are none, nothing guessed; --harness picks its own", () => {
    const env = { A_SESSION: "a", B_SESSION: "b" };
    const both = identifySession([A, B], { env });
    expect(both.kind).toBe("unidentified");
    expect(both.kind === "unidentified" && both.reason).toContain(
      "claude-code and codex each claim",
    );
    expect(identifySession([A, B], { env, harness: "codex" })).toEqual({
      kind: "identified",
      identity: { harness: "codex", session: "b" },
    });
  });

  test("--harness naming one that claims nothing is no identity, and asks no other", () => {
    expect(identifySession([A, B], { env: { A_SESSION: "a" }, harness: "codex" })).toEqual({
      kind: "unidentified",
      reason: "nothing identified the session running this (looked for B_SESSION)",
    });
  });
});
