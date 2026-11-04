import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { packCommit, packWorkingTree, readTarball } from "../../src/adapters/release.ts";

let dir = "";
const repo = () => join(dir, "repo");
const git = (...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], {
    cwd: repo(),
  });
  if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
  return ran.stdout.toString().trim();
};
const version = async (tarball: Promise<string>) =>
  (await Effect.runPromise(readTarball(await tarball))).version;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-release-"));
  await Bun.write(
    join(repo(), "package.json"),
    JSON.stringify({ name: "pkg", version: "1.2.0", files: ["lib", "missing"] }),
  );
  await Bun.write(join(repo(), "lib", "a.js"), "a\n");
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "-m", "one");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("packing", () => {
  test("only the tagged commit, clean, packs as the released version", async () => {
    const out = join(dir, "out");
    expect(await version(Effect.runPromise(packWorkingTree(repo(), out)))).toStartWith(
      "1.2.0-dev.",
    );
    git("tag", "v1.2.0");
    expect(await version(Effect.runPromise(packWorkingTree(repo(), out)))).toBe("1.2.0");
    await writeFile(join(repo(), "lib", "a.js"), "changed\n");
    expect(await version(Effect.runPromise(packWorkingTree(repo(), out)))).toMatch(
      /^1\.2\.1-dev\.[0-9a-f]{7}\.dirty$/,
    );
    git("commit", "--quiet", "-am", "two");
    const head = git("rev-parse", "--short=7", "HEAD");
    const packed = await Effect.runPromise(packWorkingTree(repo(), out));
    expect(await version(Promise.resolve(packed))).toBe(`1.2.1-dev.${head}`);
    // The dev pack ships the same files; only package.json's version differs.
    const files = [...(await Effect.runPromise(readTarball(packed))).files.keys()].sort();
    expect(files).toEqual(["package/lib/a.js", "package/package.json"]);
  });

  test("an untracked file the package would ship makes a pack at the tag a dev pack", async () => {
    git("tag", "v1.2.0");
    await Bun.write(join(repo(), "lib", "scratch.js"), "not released\n");
    expect(await version(Effect.runPromise(packWorkingTree(repo(), join(dir, "out"))))).toMatch(
      /^1\.2\.1-dev\.[0-9a-f]{7}\.dirty$/,
    );
  });

  test("an untracked file outside what the package ships leaves the release clean", async () => {
    git("tag", "v1.2.0");
    await Bun.write(join(repo(), "notes.md"), "scratch\n");
    expect(await version(Effect.runPromise(packWorkingTree(repo(), join(dir, "out"))))).toBe(
      "1.2.0",
    );
  });

  test("a commit packs as committed, whatever the working tree holds", async () => {
    git("tag", "v1.2.0");
    await writeFile(join(repo(), "lib", "a.js"), "uncommitted\n");
    const tarball = await Effect.runPromise(packCommit(repo(), "v1.2.0", join(dir, "out")));
    const read = await Effect.runPromise(readTarball(tarball));
    expect(read.version).toBe("1.2.0");
    expect(read.files.get("package/lib/a.js")).toBe(
      new Bun.CryptoHasher("sha256").update("a\n").digest("hex"),
    );
    expect(git("worktree", "list").split("\n")).toHaveLength(1);
  });
});
