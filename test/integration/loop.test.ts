/**
 * The working loop's CLI half, end to end, the way a human and their agents run it: `mshape
 * init` makes a repo, its gate passes, `track new` starts two tracks, `track list` and
 * `track current` find them, work lands on one and merges to main, and `track rm` cleans
 * both up. Every command is the new repo's installed binary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { initFromSource, pack, run, unexpectedNotes } from "./harness.ts";

let work = "";
let repo = "";
let born = { code: 0, output: "" };

const worktree = (track: string) => join(repo, ".agents", "worktrees", `demo@${track}`);

const mshape = (cwd: string, args: ReadonlyArray<string>) =>
  run(cwd, [process.execPath, join(repo, "node_modules", ".bin", "mshape"), ...args]);

const gate = (cwd: string) => run(cwd, [process.execPath, "run", "check"]);

const exists = (path: string) => Bun.file(path).exists();

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

beforeAll(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), "mshape-loop-")));
  born = await initFromSource(work, ["demo", "--from", await pack(work)]);
  repo = join(work, "demo");
}, 120_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("init, then tracks", () => {
  test("a repo born with init passes its own gate", async () => {
    expect(born.code).toBe(0);
    expect(unexpectedNotes(born.output)).toEqual([]);
    const check = await gate(repo);
    expect(check.output).toContain("mshape check passed");
    expect(check.code).toBe(0);
  }, 60_000);

  test("track new starts two tracks, each a worktree with a stub handoff", async () => {
    for (const track of ["a", "b"]) {
      const created = await mshape(repo, ["track", "new", track]);
      expect(created.output).toContain(`on \`track/${track}\` from \`main\``);
      expect(created.code).toBe(0);
      expect(await exists(join(worktree(track), "AGENTS.md"))).toBe(true);
      const handoff = await Bun.file(join(repo, ".handoffs", `${track}.md`)).text();
      expect(handoff).toStartWith(`# Track: ${track}\nStatus: stub\n`);
      // The worktree reads the same store as the main checkout.
      expect(await realpath(join(worktree(track), ".handoffs", `${track}.md`))).toBe(
        await realpath(join(repo, ".handoffs", `${track}.md`)),
      );
    }
  });

  test("track list shows both, and track current names a track only inside it", async () => {
    const list = await mshape(repo, ["track", "list"]);
    expect(list.output).toMatch(/^a\s+stub\s/m);
    expect(list.output).toMatch(/^b\s+stub\s/m);
    expect(list.code).toBe(0);

    const outside = await mshape(repo, ["track", "current"]);
    expect(outside.output).toContain("is not a track worktree");
    expect(outside.code).toBe(1);
    const inside = await mshape(worktree("a"), ["track", "current"]);
    expect(inside.output).toBe("a\n");
    expect(inside.code).toBe(0);
  });

  test("work in a track: its own install, a change, its gate, a commit", async () => {
    const a = worktree("a");
    expect((await run(a, [process.execPath, "install", "--frozen-lockfile"])).code).toBe(0);
    await put(
      join(a, "src", "core", "greet.ts"),
      "export const greet = (name: string): string => name.toUpperCase();\n",
    );
    await put(
      join(a, "test", "core", "greet.test.ts"),
      'import { expect, test } from "bun:test";\nimport { greet } from "../../src/core/greet.ts";\n\ntest("greets", () => {\n  expect(greet("a")).toBe("A");\n});\n',
    );
    const check = await gate(a);
    expect(check.output).toContain("mshape check passed");
    expect(check.output).toContain("1 pass");
    expect(check.code).toBe(0);
    expect((await run(a, ["git", "add", "--all"])).code).toBe(0);
    expect((await run(a, ["git", "commit", "--quiet", "-m", "Greet"])).code).toBe(0);
  }, 60_000);

  test("track rm refuses a track whose commits main lacks, and touches nothing", async () => {
    const refused = await mshape(repo, ["track", "rm", "a"]);
    expect(refused.code).not.toBe(0);
    expect(refused.output).toContain("`track/a` has 1 commit(s) not in `main`");
    expect(await exists(join(worktree("a"), "src", "core", "greet.ts"))).toBe(true);
    expect(await exists(join(repo, ".handoffs", "a.md"))).toBe(true);
  });

  test("once merged, track rm removes the worktree, the branch and the handoff", async () => {
    expect((await run(repo, ["git", "merge", "--quiet", "track/a"])).code).toBe(0);
    const removed = await mshape(repo, ["track", "rm", "a"]);
    expect(removed.code).toBe(0);
    expect(await exists(join(worktree("a"), "AGENTS.md"))).toBe(false);
    expect((await run(repo, ["git", "branch", "--list", "track/a"])).output).toBe("");
    expect(await exists(join(repo, ".handoffs", "a.md"))).toBe(false);
    // The other track is untouched.
    expect(await exists(join(worktree("b"), "AGENTS.md"))).toBe(true);
    expect(await exists(join(repo, ".handoffs", "b.md"))).toBe(true);
  });

  test("the last track goes too, and main's gate passes with the merged work", async () => {
    expect((await mshape(repo, ["track", "rm", "b"])).code).toBe(0);
    const list = await mshape(repo, ["track", "list"]);
    expect(list.output).not.toMatch(/^[ab]\s/m);
    expect((await run(repo, ["git", "worktree", "list"])).output.trim().split("\n")).toHaveLength(
      1,
    );
    const check = await gate(repo);
    expect(check.output).toContain("mshape check passed");
    expect(check.output).toContain("1 pass");
    expect(check.code).toBe(0);
  }, 60_000);
});
