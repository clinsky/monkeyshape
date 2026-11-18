/**
 * `initRepo` and the init command for a pack other than TypeScript, from a package root made
 * here: no pack but typescript ships a template yet, and none of them installs the npm package.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { initRepo } from "../../src/adapters/init.ts";
import { initFromSource } from "../integration/harness.ts";

const toolchain = {
  bun: "1.4.2",
  monkeyshape: "file:./vendor/monkeyshape-0.0.0.tgz",
  effect: "4.0.0",
  biome: "2.5.15",
  typescript: "7.0.2",
  typesBun: "1.4.2",
};

let work = "";

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mshape-init-pack-"));
  await Bun.write(join(work, "package", "template", "AGENTS.md"), "# {{name}}\n");
  await Bun.write(
    join(work, "package", "template", "packs", "other", "shape.toml"),
    'packs = ["other"]\n',
  );
  await Bun.write(join(work, "package", "skills", "a", "SKILL.md"), "---\nname: a\n---\n");
  await Bun.write(join(work, "monkeyshape-0.0.0.tgz"), "not npm's package");
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("init for another pack", () => {
  test("a tarball is not vendored: the repo has no vendor/ and no record of one", async () => {
    const target = join(work, "born");
    const result = await Effect.runPromise(
      initRepo(
        target,
        "born",
        join(work, "package"),
        toolchain,
        join(work, "monkeyshape-0.0.0.tgz"),
        "other",
        { version: "0.0.0-dev.abc1234" },
      ),
    );
    expect(result.done[0]).toBe("wrote 4 files");
    expect(result.done.join("\n")).not.toContain("vendor/");
    expect(result.notes.join("\n")).not.toContain("vendor/");
    expect(result.notes.join("\n")).toContain("pins mshape 0.0.0-dev.abc1234 with no sums");
    expect(await Bun.file(join(target, "vendor", "monkeyshape-0.0.0.tgz")).exists()).toBe(false);
    expect(await Bun.file(join(target, "package.json")).exists()).toBe(false);
  });

  test("the repo pins the mshape that made it, with no sums for a build no release verified", async () => {
    const target = join(work, "born");
    expect(Bun.TOML.parse(await Bun.file(join(target, "shape.toml")).text())).toEqual({
      packs: ["other"],
      mshape: { version: "0.0.0-dev.abc1234" },
    });
    expect(await Bun.file(join(target, "vendor")).exists()).toBe(false);
  });

  test("--from is refused for a pack whose repo installs no npm package", async () => {
    const tarball = join(work, "monkeyshape-0.0.0.tgz");
    for (const args of [
      ["refused", "--pack", "rust", "--from", tarball],
      ["--from", tarball, "--pack", "python", "refused"],
    ]) {
      const result = await initFromSource(work, args);
      expect(result.code).toBe(2);
      expect(result.output).toContain("a TypeScript repo installs");
    }
    expect(await Bun.file(join(work, "refused", "shape.toml")).exists()).toBe(false);
  });
});
