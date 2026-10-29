import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRefs } from "../../src/core/refs.ts";
import { config, repo } from "../support.ts";

const SKILLS = join(import.meta.dir, "../../skills");
const names = readdirSync(SKILLS);
const text = (name: string): string => readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");

describe("the shipped skills", () => {
  test("each has frontmatter naming its directory and saying when to use it", () => {
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text(name))?.[1] ?? "";
      expect(front).toContain(`name: ${name}\n`);
      expect(front).toMatch(/^description: Use .{40,}/m);
    }
  });

  // An adopter's gate checks its installed skills before /roadmap or /milestone has written
  // docs/roadmap.md, plan/ or DECISIONS.md: a skill names files it creates without backticks.
  test("pass the refs check in a repo that has only just been born", () => {
    const files = Object.fromEntries(
      names.map((name) => [`.agents/skills/${name}/SKILL.md`, text(name)]),
    );
    const born = repo({ "AGENTS.md": "# x\n", ...files }, { scripts: ["check"] });
    expect(checkRefs(config(), born)).toEqual([]);
  });
});
