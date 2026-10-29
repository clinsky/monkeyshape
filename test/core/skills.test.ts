import { describe, expect, test } from "bun:test";
import { formatSync, syncSkills } from "../../src/core/skills.ts";

const files = (entries: Record<string, string>) => new Map(Object.entries(entries));

describe("syncSkills", () => {
  test("installs every shipped skill into an empty repo", () => {
    const sync = syncSkills(
      files({ "roadmap/SKILL.md": "r", "track/SKILL.md": "t", "track/ref.md": "x" }),
      files({}),
    );
    expect(sync.added).toEqual(["roadmap", "track"]);
    expect([...sync.write.keys()].sort()).toEqual([
      "roadmap/SKILL.md",
      "track/SKILL.md",
      "track/ref.md",
    ]);
    expect(formatSync(sync)).toBe(".agents/skills: added roadmap, track");
  });

  test("replaces a changed skill whole, dropping files the package no longer has", () => {
    const sync = syncSkills(
      files({ "track/SKILL.md": "new" }),
      files({ "track/SKILL.md": "old", "track/gone.md": "x" }),
    );
    expect(sync.updated).toEqual(["track"]);
    expect(sync.write.get("track/SKILL.md")).toBe("new");
    expect(sync.remove).toEqual(["track/gone.md"]);
  });

  test("a skill with an extra installed file is not up to date", () => {
    const sync = syncSkills(files({ "a/SKILL.md": "s" }), files({ "a/SKILL.md": "s", "a/x": "" }));
    expect(sync.updated).toEqual(["a"]);
  });

  test("leaves unchanged skills and the repo's own skills alone", () => {
    const sync = syncSkills(
      files({ "roadmap/SKILL.md": "r" }),
      files({ "roadmap/SKILL.md": "r", "deploy/SKILL.md": "ours" }),
    );
    expect(sync.unchanged).toEqual(["roadmap"]);
    expect(sync.write.size).toBe(0);
    expect(sync.remove).toEqual([]);
    expect(formatSync(sync)).toBe(".agents/skills: up to date (1 shared)");
  });

  test("ignores loose files beside the skill directories", () => {
    const sync = syncSkills(files({ "README.md": "x", "a/SKILL.md": "s" }), files({}));
    expect(sync.added).toEqual(["a"]);
    expect(sync.write.has("README.md")).toBe(false);
  });
});
