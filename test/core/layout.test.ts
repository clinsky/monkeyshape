import { describe, expect, test } from "bun:test";
import {
  handoffPath,
  handoffsDir,
  TRACK_NAME,
  trackBranch,
  trackLabel,
  trackOf,
  worktreePath,
} from "../../src/core/layout.ts";

const repo = "/home/me/dev/monkey-emu";

describe("track layout", () => {
  test("everything lives under the repo's .agents/", () => {
    expect(worktreePath(repo, "docs")).toBe(
      "/home/me/dev/monkey-emu/.agents/worktrees/monkey-emu@docs",
    );
    expect(trackBranch("docs")).toBe("track/docs");
    expect(trackLabel("docs")).toBe("track:docs");
    expect(handoffsDir(repo)).toBe("/home/me/dev/monkey-emu/.agents/handoffs");
    expect(handoffPath(repo, "docs")).toBe("/home/me/dev/monkey-emu/.agents/handoffs/docs.md");
    expect(worktreePath(`${repo}/`, "docs")).toBe(worktreePath(repo, "docs"));
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
