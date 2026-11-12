import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { readChangedLines } from "../../src/adapters/baseline.ts";

let repo = "";

const git = (...args: ReadonlyArray<string>) =>
  Bun.$`git -c user.name=t -c user.email=t@example.com ${args}`.cwd(repo).quiet();

const changed = async () => {
  const lines = await Effect.runPromise(readChangedLines(repo));
  return lines === undefined
    ? undefined
    : Object.fromEntries([...lines].map(([file, set]) => [file, set === "all" ? "all" : [...set]]));
};

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "mshape-changed-"));
  await git("init", "-q", "-b", "main");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("readChangedLines", () => {
  test("committed, uncommitted and untracked changes since the merge base with main", async () => {
    await Bun.write(join(repo, "a.ts"), "1\n2\n3\n4\n");
    await Bun.write(join(repo, "b.ts"), "1\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await git("switch", "-qc", "track/x");
    await Bun.write(join(repo, "a.ts"), "1\nTWO\n3\n4\n");
    await git("commit", "-qam", "on the branch");
    await Bun.write(join(repo, "a.ts"), "1\nTWO\n3\n4\nFIVE\n");
    await Bun.write(join(repo, "c.ts"), "new\n");
    expect(await changed()).toEqual({ "a.ts": [2, 5], "c.ts": "all" });
  });

  test("a path with a space or a quote is read as itself", async () => {
    for (const name of ["my file.ts", 'say "hi".ts']) await Bun.write(join(repo, name), "1\n2\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await git("switch", "-qc", "track/x");
    for (const name of ["my file.ts", 'say "hi".ts'])
      await Bun.write(join(repo, name), "1\n2\n3\n");
    await git("commit", "-qam", "a third line each");
    expect(await changed()).toEqual({ "my file.ts": [3], 'say "hi".ts': [3] });
  });

  test("on main itself nothing changed; with no main to diff from, undefined", async () => {
    await Bun.write(join(repo, "a.ts"), "1\n");
    await git("add", "-A");
    await git("commit", "-qm", "base");
    expect(await changed()).toEqual({});
    await git("branch", "-qm", "main", "trunk");
    expect(await changed()).toBeUndefined();
  });

  test("a moved file changed only the lines edited in the move", async () => {
    await Bun.write(
      join(repo, "a.ts"),
      "export const one = 1;\nexport const two = 2;\nexport const three = 3;\n",
    );
    await git("add", "-A");
    await git("commit", "-qm", "base");
    await git("switch", "-qc", "track/x");
    await git("mv", "a.ts", "moved.ts");
    await git("commit", "-qm", "move");
    expect(await changed()).toEqual({});
  });

  test("a fresh repo with no commit: undefined", async () => {
    expect(await changed()).toBeUndefined();
  });
});
