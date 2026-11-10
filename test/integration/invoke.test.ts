/**
 * How hooks and skills run `mshape` (D-run-mshape), tried where they run it: a repo born with
 * `mshape init`, from its root, from a subdirectory, and from a track worktree that has no
 * `node_modules` of its own. The shell gets the PATH a hook gets: bun and git, no `mshape`, no
 * `node`, no package script's `node_modules/.bin`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mshapeCommand } from "../../src/core/hooks.ts";
import { initFromSource, pack, run, unexpectedNotes } from "./harness.ts";

let work = "";
let repo = "";
let bin = "";
let born = { code: 0, output: "" };

/** `mshapeCommand(args)` through `sh -c`, as Claude Code runs a hook's command. */
const hook = (cwd: string, args: ReadonlyArray<string>) =>
  run(cwd, ["/bin/sh", "-c", mshapeCommand(args)], { PATH: bin });

beforeAll(async () => {
  work = await realpath(await mkdtemp(join(tmpdir(), "mshape-invoke-")));
  born = await initFromSource(work, ["demo", "--from", await pack(work)]);
  repo = join(work, "demo");
  bin = join(work, "bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "bun"));
  await symlink(Bun.which("git") ?? "/usr/bin/git", join(bin, "git"));
  await run(repo, [
    process.execPath,
    join(repo, "node_modules", ".bin", "mshape"),
    "track",
    "new",
    "a",
  ]);
}, 120_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("running mshape from a hook", () => {
  test("the born repo and its track exist, and the hook's PATH has no mshape", async () => {
    expect(born.code).toBe(0);
    expect(unexpectedNotes(born.output)).toEqual([]);
    const bare = await run(repo, ["/bin/sh", "-c", "mshape --version"], { PATH: bin });
    expect(bare.code).not.toBe(0);
  });

  test("works from the repo root and a subdirectory", async () => {
    for (const cwd of [repo, join(repo, "test")]) {
      const version = await hook(cwd, ["--version"]);
      expect(version.output.trim()).toMatch(/^\d+\.\d+\.\d+/);
      expect(version.code).toBe(0);
      const outside = await hook(cwd, ["track", "current"]);
      expect(outside.output).toContain("is not a track worktree");
      expect(outside.code).toBe(1);
    }
  });

  test("works from a track worktree with no node_modules, and runs there", async () => {
    const worktree = join(repo, ".agents", "worktrees", "demo@a");
    expect(await Bun.file(join(worktree, "package.json")).exists()).toBe(true);
    // `track new` installs; a track made before it did, or whose install failed, has none.
    expect(await Bun.file(join(worktree, "node_modules", ".bin", "mshape")).exists()).toBe(true);
    await rm(join(worktree, "node_modules"), { recursive: true, force: true });
    expect(await Bun.file(join(worktree, "node_modules", ".bin", "mshape")).exists()).toBe(false);
    const current = await hook(worktree, ["track", "current"]);
    expect(current.output).toBe("a\n");
    expect(current.code).toBe(0);
  });

  test("passes arguments through intact and prints nothing of its own", async () => {
    const unknown = await hook(repo, ["it's two words"]);
    expect(unknown.output).toStartWith("mshape: unknown command 'it's two words'\n");
    expect(unknown.code).toBe(2);
  });
});
