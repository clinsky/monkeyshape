import { describe, expect, test } from "bun:test";
import {
  handoffPath,
  stateDir,
  TRACK_NAME,
  trackBranch,
  trackLabel,
  trackOf,
  worktreePath,
} from "../../src/core/layout.ts";

const repo = "/home/me/dev/monkey-emu";

describe("track layout", () => {
  test("names a track's worktree, branch, label, state and handoff", () => {
    expect(worktreePath(repo, "docs")).toBe("/home/me/dev/monkey-emu@docs");
    expect(trackBranch("docs")).toBe("track/docs");
    expect(trackLabel("docs")).toBe("track:docs");
    expect(stateDir(repo)).toBe("/home/me/dev/monkey-emu-state");
    expect(handoffPath(repo, "docs")).toBe("/home/me/dev/monkey-emu-state/handoffs/docs.md");
    expect(worktreePath(`${repo}/`, "docs")).toBe("/home/me/dev/monkey-emu@docs");
  });

  test("a worktree knows its track; the main checkout and strangers don't have one", () => {
    expect(trackOf(repo, "/home/me/dev/monkey-emu@cross-module")).toBe("cross-module");
    expect(trackOf(repo, repo)).toBeUndefined();
    expect(trackOf(repo, "/home/me/dev/other@docs")).toBeUndefined();
    expect(trackOf(repo, "/elsewhere/monkey-emu@docs")).toBeUndefined();
    expect(trackOf(repo, "/home/me/dev/monkey-emu@Bad_Name")).toBeUndefined();
  });

  test("track names are lowercase words joined by hyphens", () => {
    for (const ok of ["docs", "init", "cross-module", "m2"]) expect(TRACK_NAME.test(ok)).toBe(true);
    for (const bad of ["", "Docs", "-x", "x-", "a--b", "a_b", "a/b", "2x"])
      expect(TRACK_NAME.test(bad)).toBe(false);
  });
});
