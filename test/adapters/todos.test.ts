/**
 * `todosNaming`: where a `TODO(<id>)` names a bead in a commit's tree, which `track list` and
 * `track pr` say before the bead closes (jhz.1). Real git, in a temp repo.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { todosNaming } from "../../src/adapters/tracks.ts";

let repo = "";
const git = (...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "mshape-todos-")));
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  await mkdir(join(repo, "src"));
  await writeFile(join(repo, "src/a.ts"), "const a = 1;\n// TODO(x-1.2): finish\n");
  await writeFile(
    join(repo, "src/b.rs"),
    "/* TODO(x-1.2) and TODO(x-3) */\n// TODO(x-1x2): not x-1.2\n",
  );
  git("add", ".");
  git("commit", "-qm", "init");
  // Only the commit's tree counts: an uncommitted TODO isn't what merges.
  await writeFile(join(repo, "src/c.ts"), "// TODO(x-3)\n");
});
afterAll(() => rm(repo, { recursive: true, force: true }));

test("each id's TODOs as path:line, in any language, at the commit given; a dot in an id is literal", async () => {
  const found = await Effect.runPromise(todosNaming(repo, "main", ["x-1.2", "x-3", "x-9"]));
  expect(Object.fromEntries(found)).toEqual({
    "x-1.2": ["src/a.ts:2", "src/b.rs:1"],
    "x-3": ["src/b.rs:1"],
  });
});

test("no ids, or a rev git doesn't know: nothing found, never a failure", async () => {
  expect((await Effect.runPromise(todosNaming(repo, "main", []))).size).toBe(0);
  expect((await Effect.runPromise(todosNaming(repo, "nope", ["x-3"]))).size).toBe(0);
});
