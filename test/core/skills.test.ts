import { describe, expect, test } from "bun:test";
import type { SkillsLink } from "../../src/core/model.ts";
import { checkSkills, formatSync, syncSkills } from "../../src/core/skills.ts";
import { config, repo } from "../support.ts";

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

const RELATIVE: SkillsLink = { kind: "link", target: "../.agents/skills" };
const SHIPPED = { "roadmap/SKILL.md": "r", "track/SKILL.md": "t" };

const check = (
  skills: {
    link?: SkillsLink;
    installed?: Record<string, string>;
    claudeDirectory?: Record<string, string>;
    shipped?: Record<string, string>;
  } = {},
) =>
  checkSkills(
    config(),
    repo(
      {},
      {
        skills: {
          link: skills.link ?? RELATIVE,
          installed: files(skills.installed ?? SHIPPED),
          claudeDirectory: files(skills.claudeDirectory ?? {}),
          shipped: files(skills.shipped ?? SHIPPED),
        },
      },
    ),
  ).map((v) => `${v.rule} ${v.file}: ${v.message}`);

describe("checkSkills", () => {
  test("a correct install passes", () => {
    expect(check()).toEqual([]);
  });

  test("the repo's own skills pass beside the shared ones", () => {
    expect(check({ installed: { ...SHIPPED, "deploy/SKILL.md": "ours" } })).toEqual([]);
  });

  test("a repo without skills passes", () => {
    expect(check({ link: { kind: "missing" }, installed: {} })).toEqual([]);
  });

  test("a missing link says how to create it", () => {
    const [found, ...rest] = check({ link: { kind: "missing" } });
    expect(rest).toEqual([]);
    expect(found).toStartWith("skills/link .claude/skills: is missing");
    expect(found).toContain("mshape skills sync");
  });

  test("an absolute link is refused, with the relative fix", () => {
    const [found] = check({ link: { kind: "link", target: "/home/me/repo/.agents/skills" } });
    expect(found).toContain("absolute path /home/me/repo/.agents/skills");
    expect(found).toContain("rm -r .claude/skills && mshape skills sync");
  });

  test("a link elsewhere is refused", () => {
    expect(check({ link: { kind: "link", target: "../skills" } })[0]).toContain(
      "links to ../skills, not ../.agents/skills",
    );
  });

  test("a real .claude/skills directory with an extra skill reports both", () => {
    const found = check({
      link: { kind: "directory" },
      claudeDirectory: { ...SHIPPED, "mine/SKILL.md": "m" },
    });
    expect(found).toHaveLength(2);
    expect(found[0]).toStartWith("skills/link .claude/skills: is a directory");
    expect(found[1]).toStartWith("skills/unlinked .claude/skills/mine: is only in .claude/skills");
    expect(found[1]).toContain("Move it to .agents/skills/mine");
  });

  test("a skill without SKILL.md is reported", () => {
    expect(check({ installed: { ...SHIPPED, "notes/README.md": "x" } })).toEqual([
      "skills/skill-md .agents/skills/notes: has no SKILL.md, so no agent loads it. Add .agents/skills/notes/SKILL.md, or delete the directory.",
    ]);
  });

  test("a stale shared skill says a sync is due", () => {
    const [found, ...rest] = check({ shipped: { ...SHIPPED, "track/SKILL.md": "t v2" } });
    expect(rest).toEqual([]);
    expect(found).toStartWith("skills/sync-due .agents/skills/track: differs");
    expect(found).toContain("mshape skills sync");
  });

  test("a shared skill not yet installed says a sync is due", () => {
    expect(check({ shipped: { ...SHIPPED, "handoff/SKILL.md": "h" } })[0]).toStartWith(
      "skills/sync-due .agents/skills/handoff: is a shared skill monkeyshape ships",
    );
  });
});
