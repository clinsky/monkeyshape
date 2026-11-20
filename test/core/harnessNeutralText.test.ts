/**
 * What monkeyshape ships names no harness's way of starting a skill on its own: a born repo, a
 * skill or a line `mshape` prints says `/track` only beside its pair, on a line that names it
 * as Claude Code's or also says Codex's `$track`. Otherwise a Codex repo is told Claude Code's syntax (#155's
 * review). An adapter's own code (`src/harnesses/`) renders its syntax, so it is left out.
 */
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

/** Every file under `dir`, repo-relative. */
const filesUnder = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(join(ROOT, dir), { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(ROOT.length + 1));

describe("shipped text names no harness's skill syntax alone", () => {
  test("a bare /<skill> appears only on a line that names it as Claude Code's", async () => {
    const skills = (await readdir(join(ROOT, "skills"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
    expect(skills).toContain("track");
    // Not after a word, a dot, a slash, a hyphen or an escape: `docs/roadmap.md`,
    // `skills/track/` and a regex's `docs\/roadmap` aren't one.
    const bare = (skill: string) => new RegExp(`(?<![\\w./\\\\-])/${skill}(?![\\w-])`);
    const shipped = [
      ...(await filesUnder("template")),
      ...(await filesUnder("skills")),
      ...(await filesUnder("src")).filter((path) => !path.startsWith("src/harnesses/")),
    ];
    const found: Array<string> = [];
    for (const path of shipped) {
      const text = await Bun.file(join(ROOT, path)).text();
      text.split("\n").forEach((line, i) => {
        // Beside its pair: named as Claude Code's, or with Codex's `$<skill>` on the line.
        for (const skill of skills)
          if (
            bare(skill).test(line) &&
            !line.includes("Claude Code") &&
            !line.includes(`$${skill}`)
          )
            found.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });
});
