/**
 * docs/local-rules.md, run as written: its code blocks are a repo, the gate fails on the
 * documented bug with the documented output, and passes on the documented fix.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, run } from "../integration/harness.ts";

const API = join(ROOT, "src", "api", "monkeyshape.ts");
const CLI = join(ROOT, "src", "cli", "main.ts");

const blocks = async (): Promise<ReadonlyArray<string>> => {
  const text = await Bun.file(join(ROOT, "docs", "local-rules.md")).text();
  return [...text.matchAll(/```\w*\n([\s\S]*?)```/g)].map((block) => block[1] ?? "");
};

/** `// <path>` on a block's first line names its file; `// <path>, fixed` is the fix. */
const files = async (): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const block of await blocks()) {
    const [first = "", ...rest] = block.split("\n");
    const name = /^\/\/ (\S+?)(, fixed)?$/.exec(first);
    if (name?.[1] === undefined) continue;
    // The scratch repo has no node_modules: the package is this checkout's API.
    out[`${name[1]}${name[2] ?? ""}`] = `${first}\n${rest.join("\n")}`.replaceAll(
      'from "monkeyshape"',
      `from ${JSON.stringify(API)}`,
    );
  }
  return out;
};

describe("docs/local-rules.md, followed literally", () => {
  test("its blocks are the enforcement point, the rule, the config, the bug and its fix", async () => {
    expect(Object.keys(await files()).sort()).toEqual([
      "rules/indexWrites.ts",
      "shape.config.ts",
      "src/jobs/collect.ts",
      "src/jobs/collect.ts, fixed",
      "src/store/index.ts",
    ]);
  });

  test("the gate prints the documented failure on the bug, and passes on the fix", async () => {
    const all = await files();
    const { "src/jobs/collect.ts, fixed": fixed = "", ...repo } = all;
    const expected = (await blocks()).find((block) => block.startsWith("src/jobs/collect.ts:"));
    const dir = await mkdtemp(join(tmpdir(), "mshape-local-doc-"));
    try {
      for (const [path, text] of Object.entries(repo)) await Bun.write(join(dir, path), text);
      await run(dir, ["git", "init", "-q"]);
      const check = () => run(dir, [process.execPath, CLI, "check", "--only", "rules,sources"]);
      const failed = await check();
      expect(failed.output).toContain(expected ?? "(no expected output block)");
      // The cases ran clean: the only problem is the bug.
      expect(failed.output).toContain("mshape check failed: 1 problem");
      expect(failed.code).toBe(1);
      await Bun.write(join(dir, "src/jobs/collect.ts"), fixed);
      const passed = await check();
      expect(passed.output).not.toContain("rules/local");
      expect(passed.code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
