import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRefs } from "../../src/core/refs.ts";
import { DEFAULT_DOCS } from "../../src/schemas/config.ts";
import { config, repo } from "../support.ts";

const SKILLS = join(import.meta.dir, "../../skills");
const names = readdirSync(SKILLS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
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
  // docs/workflow.md ships beside them and describes the same files, so it is held to the same.
  test("pass the refs check in a repo that has only just been born", () => {
    const files = Object.fromEntries(
      names.map((name) => [`.agents/skills/${name}/SKILL.md`, text(name)]),
    );
    const workflow = readFileSync(join(import.meta.dir, "../../docs/workflow.md"), "utf8");
    const born = repo(
      { "AGENTS.md": "# x\n", "shape.config.ts": "", "docs/workflow.md": workflow, ...files },
      { scripts: ["check"] },
    );
    const checked = config({ refs: { docs: [...DEFAULT_DOCS, "docs/workflow.md"] } });
    expect(checkRefs(checked, born)).toEqual([]);
  });
});
