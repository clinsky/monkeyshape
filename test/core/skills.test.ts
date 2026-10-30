import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillsLink } from "../../src/core/model.ts";
import {
  checkSkills,
  formatCollisions,
  formatSync,
  parseManifest,
  SKILL_NAME,
  syncSkills,
} from "../../src/core/skills.ts";
import { config, repo } from "../support.ts";

const files = (entries: Record<string, string>) =>
  new Map(Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]));

const manifest = (...shared: ReadonlyArray<string>) =>
  JSON.stringify({ about: "", shared: [...shared] });

const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

describe("the package's skills", () => {
  test("every shipped skill has a name sync can record in its manifest", async () => {
    // A name outside SKILL_NAME would install, then make every later sync refuse its own manifest.
    const shipped = await readdir(join(import.meta.dir, "..", "..", "skills"), {
      withFileTypes: true,
    });
    const names = shipped.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(names.length).toBeGreaterThan(0);
    expect(names.filter((name) => !SKILL_NAME.test(name))).toEqual([]);
  });
});

describe("syncSkills", () => {
  test("installs every shipped skill into an empty repo, and records them", () => {
    const sync = syncSkills(
      files({ "roadmap/SKILL.md": "r", "track/SKILL.md": "t", "track/ref.md": "x" }),
      files({}),
    );
    expect(sync.added).toEqual(["roadmap", "track"]);
    expect([...sync.write.keys()].sort()).toEqual([
      "monkeyshape.json",
      "roadmap/SKILL.md",
      "track/SKILL.md",
      "track/ref.md",
    ]);
    expect(parseManifest(sync.write.get("monkeyshape.json") ?? new Uint8Array())).toEqual([
      "roadmap",
      "track",
    ]);
    expect(formatSync(sync)).toBe(".agents/skills: added roadmap, track");
  });

  test("replaces a changed shared skill whole, dropping files the package no longer has", () => {
    const sync = syncSkills(
      files({ "track/SKILL.md": "new" }),
      files({
        "track/SKILL.md": "old",
        "track/gone.md": "x",
        "monkeyshape.json": manifest("track"),
      }),
    );
    expect(sync.updated).toEqual(["track"]);
    expect(decode(sync.write.get("track/SKILL.md"))).toBe("new");
    expect(sync.remove).toEqual(["track/gone.md"]);
    expect(sync.write.has("monkeyshape.json")).toBe(false);
  });

  test("compares bytes, so a binary file that differs is an update", () => {
    const shipped = new Map([["a/SKILL.md", new Uint8Array([0xff, 0xfe])]]);
    const installed = new Map([
      ["a/SKILL.md", new Uint8Array([0xff, 0xfd])],
      ["monkeyshape.json", new TextEncoder().encode(manifest("a"))],
    ]);
    // Both decode to the same replacement characters as text; as bytes they differ.
    expect(syncSkills(shipped, installed).updated).toEqual(["a"]);
  });

  test("never overwrites a skill of the repo's own that shares a shipped name", () => {
    const sync = syncSkills(
      files({ "milestone/SKILL.md": "shared" }),
      files({ "milestone/SKILL.md": "ours", "milestone/helper.md": "ours" }),
    );
    expect(sync.collisions).toEqual(["milestone"]);
    expect(sync.write.has("milestone/SKILL.md")).toBe(false);
    expect(sync.remove).toEqual([]);
    expect(formatCollisions(sync)[0]).toContain("Rename yours");
  });

  test("removes a shared skill the package no longer ships", () => {
    const sync = syncSkills(
      files({ "roadmap/SKILL.md": "r" }),
      files({
        "roadmap/SKILL.md": "r",
        "review-pr/SKILL.md": "old",
        "monkeyshape.json": manifest("review-pr", "roadmap"),
      }),
    );
    expect(sync.retired).toEqual(["review-pr"]);
    expect(parseManifest(sync.write.get("monkeyshape.json") ?? new Uint8Array())).toEqual([
      "roadmap",
    ]);
    expect(formatSync(sync)).toBe(".agents/skills: removed (no longer shipped) review-pr");
  });

  test("a manifest name that isn't one skill directory makes the manifest unreadable", () => {
    for (const name of ["", ".", "..", "mine/..", "../../keep", "a/b", "Upper"])
      expect(parseManifest(new TextEncoder().encode(manifest(name)))).toBeUndefined();
    expect(parseManifest(new TextEncoder().encode(manifest("review-pr", "a2")))).toEqual([
      "review-pr",
      "a2",
    ]);
  });

  test("retires only installed skill directories, so a stale name deletes nothing", () => {
    const sync = syncSkills(
      files({ "roadmap/SKILL.md": "r" }),
      files({ "roadmap/SKILL.md": "r", "monkeyshape.json": manifest("gone", "roadmap") }),
    );
    expect(sync.retired).toEqual([]);
    expect(parseManifest(sync.write.get("monkeyshape.json") ?? new Uint8Array())).toEqual([
      "roadmap",
    ]);
  });

  test("leaves unchanged skills and the repo's own skills alone", () => {
    const sync = syncSkills(
      files({ "roadmap/SKILL.md": "r" }),
      files({
        "roadmap/SKILL.md": "r",
        "deploy/SKILL.md": "ours",
        "monkeyshape.json": manifest("roadmap"),
      }),
    );
    expect(sync.unchanged).toEqual(["roadmap"]);
    expect(sync.write.size).toBe(0);
    expect(sync.retired).toEqual([]);
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
const INSTALLED = { ...SHIPPED, "monkeyshape.json": manifest("roadmap", "track") };

/** By default git lists the link and every installed file, as after a commit. */
const check = (
  skills: {
    link?: SkillsLink;
    installed?: Record<string, string>;
    claudeDirectory?: Record<string, string>;
    shipped?: Record<string, string>;
    tracked?: ReadonlyArray<string>;
  } = {},
) => {
  const installed = skills.installed ?? INSTALLED;
  const tracked = skills.tracked ?? [
    ".claude/skills",
    ...Object.keys(installed).map((path) => `.agents/skills/${path}`),
  ];
  return checkSkills(
    config(),
    repo(Object.fromEntries(tracked.map((path) => [path, ""])), {
      skills: {
        link: skills.link ?? RELATIVE,
        installed: files(installed),
        claudeDirectory: files(skills.claudeDirectory ?? {}),
        shipped: files(skills.shipped ?? SHIPPED),
      },
    }),
  ).map((v) => `${v.rule} ${v.file}: ${v.message}`);
};

describe("checkSkills", () => {
  test("a correct install passes", () => {
    expect(check()).toEqual([]);
  });

  test("the repo's own skills pass beside the shared ones", () => {
    expect(check({ installed: { ...INSTALLED, "deploy/SKILL.md": "ours" } })).toEqual([]);
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

  test("a link elsewhere is refused; spellings of the right target are not", () => {
    expect(check({ link: { kind: "link", target: "../skills" } })[0]).toContain(
      "links to ../skills, not ../.agents/skills",
    );
    for (const target of ["../.agents/skills/", "./../.agents/skills"])
      expect(check({ link: { kind: "link", target } })).toEqual([]);
  });

  test("a link git ignores says how to commit it", () => {
    const tracked = Object.keys(INSTALLED).map((path) => `.agents/skills/${path}`);
    const [found, ...rest] = check({ tracked });
    expect(rest).toEqual([]);
    expect(found).toStartWith("skills/untracked .claude/skills: is ignored by git");
    expect(found).toContain("`.claude/*` and add `!.claude/skills`");
  });

  test("an ignored skill is reported once, by its directory", () => {
    const ignored = check({
      installed: { ...INSTALLED, "deploy/SKILL.md": "ours", "deploy/ref.md": "x" },
      tracked: [".claude/skills", ...Object.keys(INSTALLED).map((p) => `.agents/skills/${p}`)],
    });
    expect(ignored).toHaveLength(1);
    expect(ignored[0]).toStartWith("skills/untracked .agents/skills/deploy: is ignored by git");
  });

  test("a symlinked skill git lists as one entry counts as committed", () => {
    expect(
      check({
        installed: { ...INSTALLED, "vendored/SKILL.md": "v" },
        tracked: [
          ".claude/skills",
          ...Object.keys(INSTALLED).map((p) => `.agents/skills/${p}`),
          ".agents/skills/vendored",
        ],
      }),
    ).toEqual([]);
  });

  test("a real .claude/skills directory reports skills only there, and copies that differ", () => {
    const found = check({
      link: { kind: "directory" },
      claudeDirectory: {
        "roadmap/SKILL.md": "edited",
        "track/SKILL.md": "t",
        "mine/SKILL.md": "m",
      },
    });
    expect(found).toHaveLength(3);
    expect(found[0]).toStartWith("skills/link .claude/skills: is a directory");
    expect(found[0]).toContain("The fix deletes it: first move or merge every skill");
    expect(found[1]).toStartWith("skills/diverged .claude/skills/roadmap: differs");
    expect(found[1]).toContain("before relinking");
    expect(found[2]).toStartWith("skills/unlinked .claude/skills/mine: is only in .claude/skills");
  });

  test("a skill without SKILL.md is reported", () => {
    expect(check({ installed: { ...INSTALLED, "notes/README.md": "x" } })).toEqual([
      "skills/skill-md .agents/skills/notes: has no SKILL.md, so no agent loads it. Add .agents/skills/notes/SKILL.md, or delete the directory.",
    ]);
  });

  test("an unreadable manifest is reported, and asks for no sync", () => {
    for (const text of ["{", manifest("../../keep"), manifest(".."), manifest("")]) {
      const found = check({ installed: { "mine/SKILL.md": "m", "monkeyshape.json": text } });
      expect(found[0]).toStartWith("skills/manifest .agents/skills/monkeyshape.json");
      expect(found[0]).toContain("sync refuses to run");
      expect(found.some((line) => line.includes("../"))).toBe(false);
    }
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

  test("a retired shared skill says a sync is due", () => {
    expect(check({ shipped: { "roadmap/SKILL.md": "r" } })[0]).toStartWith(
      "skills/sync-due .agents/skills/track: is a shared skill monkeyshape no longer ships",
    );
  });

  test("a skill of the repo's own with a shipped name is a collision, not a sync", () => {
    const found = check({
      installed: { ...INSTALLED, "milestone/SKILL.md": "ours" },
      shipped: { ...SHIPPED, "milestone/SKILL.md": "shared" },
    });
    expect(found).toHaveLength(1);
    expect(found[0]).toStartWith(
      "skills/collision .agents/skills/milestone: is a skill of this repo's own",
    );
    expect(found[0]).toContain("Rename yours");
  });
});
