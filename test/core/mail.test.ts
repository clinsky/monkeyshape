import { describe, expect, test } from "bun:test";
import {
  decodeMessage,
  directoryAddress,
  encodeMessage,
  formatAllInboxes,
  formatInbox,
  formatMessage,
  knownAddresses,
  knownTracks,
  MESSAGE_ID,
  type Message,
  messageId,
  recipientProblem,
  SUBJECT_MAX,
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

  test("a directory's address is its track, main, or review-<n>; anywhere else has none", () => {
    const review = `${REPO}/.agents/worktrees/app.pr-12`;
    const worktrees = [worktree(REPO, "main"), worktree(review)];
    const notTrack = { reason: "not a track" };
    const at = (toplevel: string, track: { track: string } | { reason: string }) =>
      directoryAddress(REPO, toplevel, worktrees, track);
    expect(at("/anything", { track: "docs" })).toEqual({ address: "docs" });
    expect(at(REPO, notTrack)).toEqual({ address: "main" });
    expect(at(review, notTrack)).toEqual({ address: "review-12" });
    const stray = at(`${REPO}/.agents/worktrees/app.pr-13`, notTrack);
    expect("reason" in stray && stray.reason).toContain("have an address");
  });

  test("a recipient is a track with a worktree or a handoff; a typo names the real ones", () => {
    const worktrees = [
      worktree(REPO, "main"),
      worktree(`${REPO}/.agents/worktrees/app@docs`, "track/docs"),
    ];
    const handoffs = ["tracks.md", "notes.txt", "Bad.md"];
    expect(knownTracks(REPO, worktrees, handoffs)).toEqual(["docs", "tracks"]);
    const known = knownAddresses(
      REPO,
      [...worktrees, worktree(`${REPO}/.agents/worktrees/app.pr-12`)],
      handoffs,
    );
    expect(known).toEqual(["docs", "tracks", "main", "review-12"]);
    for (const to of known) expect(recipientProblem(to, known)).toBeUndefined();
    expect(recipientProblem("doc", known)).toContain("addresses: docs, tracks, main, review-12");
    expect(recipientProblem("review-13", known)).toContain("no review of #13 to send to");
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

  test("--all groups unread mail by address, says what to do with a gone one's, and marks nothing", () => {
    const first = message("20261103-140000-0001", "2026-11-03T14:00:00.000Z", "first");
    const second = message("20261103-150000-0002", "2026-11-03T15:00:00.000Z", "second");
    const box = (
      track: string,
      known: boolean,
      messages: Array<Message>,
      unreadable: Array<{ file: string; reason: string }> = [],
    ) => ({
      address: track,
      known,
      dir: `/r/.git/monkeyshape/mail/${track}`,
      messages,
      unreadable,
    });
    const shown = formatAllInboxes([
      box("tracks", true, [second, first]),
      box("docs", true, []),
      box("old", false, [first]),
      box("review-7", false, [first]),
    ]);
    expect(shown.split("\n")).toEqual([
      "old: 1 unread (no such track: its worktree and handoff are gone; recreate it with `bun run --silent mshape track new old` to read this, or delete /r/.git/monkeyshape/mail/old if it is no longer wanted)",
      "  20261103-140000-0001  from tracks, 2026-11-03 14:00 UTC: first",
      "review-7: 1 unread (no review of #7 is running; `bun run --silent mshape review 7` from the main checkout moves a session there to read it, or delete /r/.git/monkeyshape/mail/review-7 if it is no longer wanted)",
      "  20261103-140000-0001  from tracks, 2026-11-03 14:00 UTC: first",
      "tracks: 2 unread",
      "  20261103-140000-0001  from tracks, 2026-11-03 14:00 UTC: first",
      "  20261103-150000-0002  from tracks, 2026-11-03 15:00 UTC: second",
      "4 unread in 3 mailboxes. Each address reads its own, from a session there, with `bun run --silent mshape msg read <id>`; this marks nothing read.",
    ]);
    expect(formatAllInboxes([box("docs", true, [])])).toBe("No unread mail anywhere.");
  });

  test("--all counts only mailboxes with unread mail; files that aren't messages are counted apart", () => {
    const first = message("20261103-140000-0001", "2026-11-03T14:00:00.000Z", "first");
    const box = (track: string, messages: Array<Message>, files: number) => ({
      address: track,
      known: true,
      dir: `/r/${track}`,
      messages,
      unreadable: Array.from({ length: files }, (_, i) => ({
        file: `x${i}.json`,
        reason: "not JSON",
      })),
    });
    const summary = (boxes: Parameters<typeof formatAllInboxes>[0]) =>
      formatAllInboxes(boxes).split("\n").at(-1);
    expect(summary([box("review", [], 1), box("tracks", [first], 0)])).toStartWith(
      "1 unread in 1 mailbox, and 1 file that isn't a message.",
    );
    expect(summary([box("review", [], 2)])).toStartWith(
      "0 unread in 0 mailboxes, and 2 files that aren't messages.",
    );
  });
});
