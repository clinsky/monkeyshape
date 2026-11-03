import { describe, expect, test } from "bun:test";
import {
  handoffPath,
  handoffsLink,
  handoffsStore,
  mailboxDir,
  mailboxReadDir,
  mailDir,
  mainCheckout,
  messagePath,
  sessionPath,
  sessionsDir,
  TRACK_NAME,
  trackBranch,
  trackLabel,
  trackOf,
  trackSessionsDir,
  worktreePath,
} from "../../src/core/layout.ts";

const repo = "/home/me/dev/monkey-emu";
const common = `${repo}/.git`;

describe("track layout", () => {
  test("everything lives under the repo's .agents/", () => {
    expect(worktreePath(repo, "docs")).toBe(
      "/home/me/dev/monkey-emu/.agents/worktrees/monkey-emu@docs",
    );
    expect(trackBranch("docs")).toBe("track/docs");
    expect(trackLabel("docs")).toBe("track:docs");
    expect(handoffsLink(repo)).toBe("/home/me/dev/monkey-emu/.agents/handoffs");
    expect(worktreePath(`${repo}/`, "docs")).toBe(worktreePath(repo, "docs"));
  });

  test("handoffs are stored under git's common directory, out of reach of git clean", () => {
    expect(mainCheckout(common)).toBe(repo);
    expect(mainCheckout(`${common}/`)).toBe(repo);
    expect(handoffsStore(common)).toBe("/home/me/dev/monkey-emu/.git/monkeyshape/handoffs");
    expect(handoffPath(common, "docs")).toBe(
      "/home/me/dev/monkey-emu/.git/monkeyshape/handoffs/docs.md",
    );
  });

  test("mail and sessions are stored beside the handoffs, one directory per track", () => {
    const store = "/home/me/dev/monkey-emu/.git/monkeyshape";
    expect(mailDir(common)).toBe(`${store}/mail`);
    expect(mailDir(`${common}/`)).toBe(`${store}/mail`);
    expect(mailboxDir(common, "docs")).toBe(`${store}/mail/docs`);
    expect(mailboxReadDir(common, "docs")).toBe(`${store}/mail/docs/read`);
    expect(messagePath(common, "docs", "m1")).toBe(`${store}/mail/docs/m1.json`);
    expect(sessionsDir(common)).toBe(`${store}/sessions`);
    expect(trackSessionsDir(common, "docs")).toBe(`${store}/sessions/docs`);
    expect(sessionPath(common, "docs", "s1")).toBe(`${store}/sessions/docs/s1.json`);
    expect(handoffsStore(common)).toBe(`${store}/handoffs`);
  });

  test("a worktree knows its track; the main checkout and strangers don't have one", () => {
    const worktrees = `${repo}/.agents/worktrees`;
    expect(trackOf(repo, `${worktrees}/monkey-emu@cross-module`)).toBe("cross-module");
    expect(trackOf(repo, `${worktrees}/monkey-emu@docs/`)).toBe("docs");
    expect(trackOf(repo, repo)).toBeUndefined();
    expect(trackOf(repo, `${worktrees}/other@docs`)).toBeUndefined();
    expect(trackOf(repo, "/home/me/dev/monkey-emu@docs")).toBeUndefined();
    expect(trackOf(repo, `${worktrees}/monkey-emu@Bad_Name`)).toBeUndefined();
    expect(trackOf(repo, `${worktrees}/monkey-emu@docs/src`)).toBeUndefined();
  });

  test("track names are lowercase words joined by hyphens", () => {
    for (const ok of ["docs", "init", "cross-module", "m2"]) expect(TRACK_NAME.test(ok)).toBe(true);
    for (const bad of ["", "Docs", "-x", "x-", "a--b", "a_b", "a/b", "2x"])
      expect(TRACK_NAME.test(bad)).toBe(false);
  });
});
