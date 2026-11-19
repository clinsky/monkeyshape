/**
 * docs/local-rules.md, run as written: its code blocks are a repo, the gate fails on the
 * documented bug with the documented output, and passes on the documented fix. Its rule runs
 * on the ast-grep `mshape` fetches, into the machine's cache.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, run } from "../integration/harness.ts";

const CLI = join(ROOT, "src", "cli", "main.ts");

const blocks = async (): Promise<ReadonlyArray<string>> => {
  const text = await Bun.file(join(ROOT, "docs", "local-rules.md")).text();
  return [...text.matchAll(/```\w*\n([\s\S]*?)```/g)].map((block) => block[1] ?? "");
};

/**
 * `// <path>` or `# <path>` on a block's first line names its file, in the file's own
 * comment syntax; `, fixed` after it is the fix.
 */
const files = async (): Promise<Record<string, string>> => {
  const out: Record<string, string> = {};
  for (const block of await blocks()) {
    const name = /^(?:\/\/|#) (\S+?)(, fixed)?$/.exec(block.split("\n")[0] ?? "");
    if (name?.[1] === undefined) continue;
    out[`${name[1]}${name[2] ?? ""}`] = block;
  }
  return out;
};

describe("docs/local-rules.md, followed literally", () => {
  test("its blocks are the enforcement point, the rule, the config, the bug and its fix", async () => {
    expect(Object.keys(await files()).sort()).toEqual([
      "shape-rules/index-writes-merge.test.yml",
      "shape-rules/index-writes-merge.yml",
      "shape-rules/no-closed-ticket.test.yml",
      "shape-rules/no-closed-ticket.yml",
      "shape-rules/no-vendor.test.yml",
      "shape-rules/no-vendor.yml",
      "shape-rules/storage-root.test.yml",
      "shape-rules/storage-root.yml",
      "shape.toml",
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

      // The three kinds over real files: each reports where it should, and the vendor rule
      // stays out of the directory its files scope leaves out.
      const kinds: Record<string, string> = {
        "src/jobs/walk.ts": "/** Re-walks the frontier (`OPS-112`). */\nexport const walk = 1;\n",
        "src/jobs/state.ts":
          'export const state = function* () {\n  const st = yield* Storage;\n  return join(st.root, "state");\n};\n',
        "src/core/layout.ts": "export const acmeRoot = 1;\n",
        "src/cli/targets.ts": 'export const vendor = "acme";\n',
      };
      for (const [path, text] of Object.entries(kinds)) await Bun.write(join(dir, path), text);
      const reported = await check();
      expect(
        reported.output
          .split("\n")
          .filter((line) => /^\S+:\d+ +rules\/local\//u.test(line))
          .sort(),
      ).toEqual([
        "src/core/layout.ts:1  rules/local/no-vendor",
        "src/jobs/state.ts:3  rules/local/storage-root",
        "src/jobs/walk.ts:1  rules/local/no-closed-ticket",
      ]);
      expect(reported.output).toContain(
        "reads st.root, which skips what lend records. Lend a directory with st.lend(dir) instead.",
      );
      expect(reported.output).toContain('"acmeRoot" names a vendor.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
