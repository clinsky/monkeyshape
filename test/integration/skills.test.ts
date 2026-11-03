import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkRefs } from "../../src/core/refs.ts";
import { scaffold } from "../../src/core/scaffold.ts";
import { DEFAULT_DOCS } from "../../src/schemas/config.ts";
import { config, repo } from "../support.ts";

const SKILLS = join(import.meta.dir, "../../skills");
const TOOLCHAIN = {
  bun: "1.4.2",
  monkeyshape: "0.2.0",
  effect: "4.0.0",
  biome: "2.5.15",
  typescript: "7.0.2",
  typesBun: "1.4.2",
};
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
    // The born repo as init writes it: the template rendered, its generated configs, and the
    // installed skills. Built from template/, so a file init adds or drops is seen here too.
    const TEMPLATE = join(import.meta.dir, "../../template");
    const template = new Map(
      readdirSync(TEMPLATE, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => {
          const path = join(entry.parentPath, entry.name);
          return [path.slice(TEMPLATE.length + 1), readFileSync(path, "utf8")] as const;
        }),
    );
    const files = Object.fromEntries([
      ...scaffold("born", template, TOOLCHAIN),
      ...names.map((name) => [`.agents/skills/${name}/SKILL.md`, text(name)] as const),
      // Ships beside the skills in the package and describes the same files.
      ["docs/workflow.md", readFileSync(join(import.meta.dir, "../../docs/workflow.md"), "utf8")],
    ]);
    const pkg = JSON.parse(files["package.json"] ?? "{}");
    const born = repo(files, { scripts: Object.keys(pkg.scripts ?? {}) });
    expect(pkg.scripts).toHaveProperty("mshape");
    const checked = config({ refs: { docs: [...DEFAULT_DOCS, "docs/workflow.md"] } });
    expect(checkRefs(checked, born)).toEqual([]);
  });
});
