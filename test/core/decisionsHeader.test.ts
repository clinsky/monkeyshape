import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// The skills apply "the merit test in DECISIONS.md's header", but `sync` refreshes skills
// and not DECISIONS.md: an adopter born before the header bumps to skills that cite a test
// its file lacks. Each skill that cites the header must say where to get it.
const ROOT = join(import.meta.dir, "..", "..");
const HEADER = /merit test/i;

test("each skill citing DECISIONS.md's header names the template's copy", async () => {
  const names = await readdir(join(ROOT, "skills"));
  const citing: Array<string> = [];
  for (const name of names) {
    const text = await Bun.file(join(ROOT, "skills", name, "SKILL.md")).text();
    if (!HEADER.test(text)) continue;
    citing.push(name);
    expect({ name, fallback: /template\/DECISIONS\.md/.test(text) }).toEqual({
      name,
      fallback: true,
    });
  }
  expect(citing.length).toBeGreaterThan(0);
});

test("this repo's DECISIONS.md carries the template's merit test and lifecycle", async () => {
  // The two paragraphs the skills cite; the template also explains the entry format.
  const rules = async (file: string) =>
    /An entry earns its slot[\s\S]*?maintainer's call\./.exec(
      await Bun.file(join(ROOT, file)).text(),
    )?.[0];
  const template = await rules("template/DECISIONS.md");
  expect(template).toBeDefined();
  expect(await rules("DECISIONS.md")).toBe(template);
});
