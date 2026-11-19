import { describe, expect, test } from "bun:test";
import { findings, isLgtm, pushMessage, reviewMessage } from "../../src/core/handshake.ts";
import { REVIEW_MARKER, reviewDecision, reviewPosted } from "../../src/core/trackPr.ts";

const comment = (body: string, path = "a.ts", line = 3) => ({ path, line, side: "RIGHT", body });

describe("the review's findings", () => {
  test("severity and summary from each comment's bold opening, in the forms reviewers write", () => {
    expect(
      findings({
        comments: [
          comment("**Blocker: the walk goes too far.**\n\nProbe..."),
          comment("**Nit**: a name", "b.ts", 9),
          comment("**Blocker (prose):** two docs disagree"),
          comment("Plain words, no label"),
        ],
      }),
    ).toEqual([
      { severity: "blocker", at: "a.ts:3", summary: "the walk goes too far." },
      { severity: "nit", at: "b.ts:9", summary: "a name" },
      { severity: "blocker", at: "a.ts:3", summary: "two docs disagree" },
      { severity: "finding", at: "a.ts:3", summary: "Plain words, no label" },
    ]);
    expect(findings({ comments: "not a list" })).toEqual([]);
  });

  test("LGTM: the word in the body and no blocker; never beside one", () => {
    expect(isLgtm({ body: "LGTM: verified." })).toBe(true);
    expect(isLgtm({ body: "No LGTM yet.", comments: [comment("**Blocker: x**")] })).toBe(false);
    expect(isLgtm({ body: "LGTM once the nit is in", comments: [comment("**Nit: y**")] })).toBe(
      true,
    );
    expect(isLgtm({ body: "looks fine" })).toBe(false);
  });

  test("the track's message: link, tally and one line per finding; LGTM is one line", () => {
    const message = reviewMessage(
      "9",
      "https://example.test/r",
      { comments: [comment("**Blocker: x.**"), comment("**Nit: y**")] },
      "review-docs",
    );
    expect(message.subject).toBe("#9 reviewed: 1 blocker, 1 nit");
    expect(message.body).toContain("- blocker (a.ts:3): x.");
    expect(message.body).toContain("track pr mails review-docs");
    expect(reviewMessage("9", "u", { body: "LGTM" }, "review-docs").subject).toBe("#9: LGTM");
    expect(reviewMessage("9", "u", { body: "## Fit" }, "review-docs").subject).toBe(
      "#9 reviewed: no inline findings",
    );
  });

  test("the reviewer's message: the head, and CI's outcome with each run when waited for", () => {
    const head = "a".repeat(40);
    expect(pushMessage(7, "u", head).subject).toBe("#7 pushed aaaaaaaaaaaa: CI not waited for");
    const failed = pushMessage(7, "u", head, [
      { id: 1, name: "check", status: "completed", conclusion: "failure", html_url: "https://r/1" },
    ]);
    expect(failed.subject).toBe("#7 pushed aaaaaaaaaaaa: CI failed");
    expect(failed.body).toContain("- check: failure https://r/1");
  });
});

describe("whether track pr may push during review", () => {
  const facts = {
    pr: 7,
    address: "review-docs",
    live: ["s"],
    registered: true,
    reviewedHead: false,
    reviewed: false,
    moves: true,
  };

  test("the first review in progress: refused", () => {
    expect("refuse" in reviewDecision(facts)).toBe(true);
  });

  test("a review posted, its answer split over pushes (gyd): each pushes", () => {
    expect(reviewDecision({ ...facts, reviewed: true })).toEqual({ note: undefined });
  });

  test("no reviewer before any review (gnv): pushes", () => {
    expect("note" in reviewDecision({ ...facts, live: [], registered: false })).toBe(true);
  });

  test("a posted review counts as review post marks it; a thread reply never does", () => {
    expect(reviewPosted([{ commit_id: "x", body: "" }])).toBe(false);
    expect(reviewPosted([{ commit_id: "x", body: `## Fit\n\n${REVIEW_MARKER}` }])).toBe(true);
  });
});
