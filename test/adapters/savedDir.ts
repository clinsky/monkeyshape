/**
 * A temp directory a test file builds once and restores before each test. Restored at the
 * same path, never copied elsewhere: git worktrees and remotes record absolute paths.
 */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const copy = (from: string, to: string) => {
  const result = Bun.spawnSync(["cp", "-a", from, to], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`cp -a ${from} ${to}: ${result.stderr}`);
};

/**
 * `build` fills a fresh directory once, in beforeAll; each test then starts from a copy of what
 * it built, so the CLI runs the build needs (`track new`) aren't repeated per test.
 * Call once at the top of a test file; `ready` gets the directory before the build.
 */
export const useSavedDir = (
  prefix: string,
  ready: (dir: string) => void,
  build: () => Promise<void>,
) => {
  let dir = "";
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
    ready(dir);
    await build();
    copy(dir, `${dir}.saved`);
  });
  beforeEach(async () => {
    await rm(dir, { recursive: true, force: true });
    copy(`${dir}.saved`, dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}.saved`, { recursive: true, force: true });
  });
};
