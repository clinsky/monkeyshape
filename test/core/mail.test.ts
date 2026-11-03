import { describe, expect, test } from "bun:test";
import {
  decodeMessage,
  encodeMessage,
  formatInbox,
  formatMessage,
  knownTracks,
  MESSAGE_ID,
  type Message,
  messageId,
  recipientProblem,
  SUBJECT_MAX,
  senderOf,
  subjectProblem,
} from "../../src/core/mail.ts";
import type { Worktree } from "../../src/core/tracks.ts";

const REPO = "/r/app";
const worktree = (path: string, branch?: string): Worktree => ({
  path,
  branch,
  prunable: false,
});
const message = (id: string, created: string, subject = "hello"): Message => ({
  id,
  from: "tracks",
  to: "messaging",
  subject,
  body: "the body",
  created,
});

describe("mail", () => {
  test("an id sorts by time and matches its own pattern", () => {
    const id = messageId(new Date("2026-11-03T14:25:07.123Z"), "a3f9");
    expect(id).toBe("20261103-142507-a3f9");
    expect(MESSAGE_ID.test(id)).toBe(true);
    expect(MESSAGE_ID.test("../x")).toBe(false);
  });

  test("a subject is one non-empty line that fits a notice", () => {
    expect(subjectProblem("PR #30 changes the handoff parser")).toBeUndefined();
    expect(subjectProblem("  ")).toContain("empty");
    for (const control of ["one\ntwo", "a\rb", "tab\there", "red \u001b[31mX\u001b[0m"])
      expect(subjectProblem(control)).toContain("control character");
    expect(subjectProblem("x".repeat(SUBJECT_MAX + 1))).toContain("put the rest in the body");
  });

  test("the sender is the track, main, or review-<n>; anywhere else is refused", () => {
    const review = `${REPO}/.agents/worktrees/app.pr-12`;
    const worktrees = [worktree(REPO, "main"), worktree(review)];
    const notTrack = { reason: "not a track" };
    expect(senderOf(REPO, "/anything", worktrees, { track: "docs" })).toEqual({ from: "docs" });
    expect(senderOf(REPO, REPO, worktrees, notTrack)).toEqual({ from: "main" });
    expect(senderOf(REPO, review, worktrees, notTrack)).toEqual({ from: "review-12" });
    const stray = senderOf(REPO, `${REPO}/.agents/worktrees/app.pr-13`, worktrees, notTrack);
    expect("reason" in stray && stray.reason).toContain("Send from a track's worktree");
  });

  test("a recipient is a track with a worktree or a handoff; a typo names the real ones", () => {
    const worktrees = [
      worktree(REPO, "main"),
      worktree(`${REPO}/.agents/worktrees/app@docs`, "track/docs"),
    ];
    const known = knownTracks(REPO, worktrees, ["tracks.md", "notes.txt", "Bad.md"]);
    expect(known).toEqual(["docs", "tracks"]);
    expect(recipientProblem("docs", known)).toBeUndefined();
    expect(recipientProblem("doc", known)).toContain("tracks: docs, tracks");
  });

  test("a message round-trips, and a file that isn't one says why", () => {
    const sent = message("20261103-142507-a3f9", "2026-11-03T14:25:07.123Z");
    expect(decodeMessage(encodeMessage(sent))).toEqual(sent);
    expect(decodeMessage("{")).toContain("not JSON");
    expect(decodeMessage(JSON.stringify({ ...sent, subject: 3 }))).toContain("subject");
    expect(decodeMessage(JSON.stringify({ ...sent, extra: "x" }))).toContain("unknown keys: extra");
  });

  test("the inbox lists oldest first with the read command; quiet and empty prints nothing", () => {
    const inbox = formatInbox(
      "messaging",
      [
        message("20261103-150000-0002", "2026-11-03T15:00:00.000Z", "second"),
        message("20261103-140000-0001", "2026-11-03T14:00:00.000Z", "first"),
      ],
      [],
      true,
    );
    expect(inbox.split("\n")).toEqual([
      "Unread messages for track messaging. Read one with `bun run --silent mshape msg read <id>`; until then it stays unread.",
      "  20261103-140000-0001  from tracks, 2026-11-03 14:00 UTC: first",
      "  20261103-150000-0002  from tracks, 2026-11-03 15:00 UTC: second",
    ]);
    expect(formatInbox("messaging", [], [], true)).toBe("");
    expect(formatInbox("messaging", [], [], false)).toBe("No unread messages for track messaging.");
    expect(formatInbox("messaging", [], [{ file: "x.json", reason: "not JSON" }], true)).toContain(
      "note: x.json in messaging's mailbox is not a message (not JSON)",
    );
  });

  test("a read message prints its headers and body, and says when it was read before", () => {
    const shown = formatMessage(message("20261103-140000-0001", "2026-11-03T14:00:00.000Z"), true);
    expect(shown).toBe(
      "From: tracks\nTo: messaging\nDate: 2026-11-03 14:00 UTC\nSubject: hello\n(already read)\n\nthe body",
    );
  });
});
