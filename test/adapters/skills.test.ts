import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect, Exit } from "effect";
import { installSkills } from "../../src/adapters/skills.ts";

let dir = "";
const shipped = () => join(dir, "package", "skills");
const repo = () => join(dir, "repo");

const put = async (path: string, text: string | Uint8Array) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

const install = () => Effect.runPromise(installSkills(shipped(), repo()));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-skills-"));
  await put(join(shipped(), "roadmap", "SKILL.md"), "roadmap v1\n");
  await put(join(shipped(), "track", "SKILL.md"), "track v1\n");
  await mkdir(repo());
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("installSkills", () => {
  test("copies the skills and links .claude/skills relatively to them", async () => {
    const first = await install();
    expect(first.sync.added).toEqual(["roadmap", "track"]);
    expect(first.linked).toBe(true);
    expect(await readlink(join(repo(), ".claude", "skills"))).toBe("../.agents/skills");
    expect(await Bun.file(join(repo(), ".claude", "skills", "track", "SKILL.md")).text()).toBe(
      "track v1\n",
    );
    expect(await realpath(join(repo(), ".claude", "skills"))).toBe(
      await realpath(join(repo(), ".agents", "skills")),
    );
  });

  test("sync after a bump replaces changed skills and keeps the repo's own", async () => {
    await install();
    await put(join(repo(), ".agents", "skills", "deploy", "SKILL.md"), "ours\n");
    await put(join(shipped(), "track", "SKILL.md"), "track v2\n");
    const again = await install();
    expect(again.sync.updated).toEqual(["track"]);
    expect(again.sync.unchanged).toEqual(["roadmap"]);
    expect(again.linked).toBe(false);
    expect(await Bun.file(join(repo(), ".agents", "skills", "track", "SKILL.md")).text()).toBe(
      "track v2\n",
    );
    expect(await Bun.file(join(repo(), ".agents", "skills", "deploy", "SKILL.md")).text()).toBe(
      "ours\n",
    );
  });

  test("leaves an existing .claude/skills directory for the check to report", async () => {
    await put(join(repo(), ".claude", "skills", "mine", "SKILL.md"), "mine\n");
    const result = await install();
    expect(result.linked).toBe(false);
    expect(await Bun.file(join(repo(), ".claude", "skills", "mine", "SKILL.md")).text()).toBe(
      "mine\n",
    );
  });

  test("a symlinked skill is read through its link", async () => {
    await put(join(dir, "vendor", "linked", "SKILL.md"), "linked\n");
    await symlink(join(dir, "vendor", "linked"), join(shipped(), "linked"));
    const result = await install();
    expect(result.sync.added).toEqual(["linked", "roadmap", "track"]);
    expect(await Bun.file(join(repo(), ".agents", "skills", "linked", "SKILL.md")).text()).toBe(
      "linked\n",
    );
  });

  test("a skill of the repo's own with a shipped name is left exactly as it was", async () => {
    await put(join(repo(), ".agents", "skills", "track", "SKILL.md"), "ours\n");
    await put(join(repo(), ".agents", "skills", "track", "helper.md"), "ours\n");
    const result = await install();
    expect(result.sync.collisions).toEqual(["track"]);
    expect(await Bun.file(join(repo(), ".agents", "skills", "track", "SKILL.md")).text()).toBe(
      "ours\n",
    );
    expect(await Bun.file(join(repo(), ".agents", "skills", "track", "helper.md")).exists()).toBe(
      true,
    );
  });

  test("a shared skill the package drops is removed; the repo's own stay", async () => {
    await install();
    await put(join(repo(), ".agents", "skills", "deploy", "SKILL.md"), "ours\n");
    await rm(join(shipped(), "track"), { recursive: true });
    const result = await install();
    expect(result.sync.retired).toEqual(["track"]);
    expect(await Bun.file(join(repo(), ".agents", "skills", "track")).exists()).toBe(false);
    expect(await Bun.file(join(repo(), ".agents", "skills", "deploy", "SKILL.md")).exists()).toBe(
      true,
    );
  });

  test("copies binary files byte for byte", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00, 0xfe]);
    await put(join(shipped(), "track", "icon.png"), bytes);
    await install();
    expect(await Bun.file(join(repo(), ".agents", "skills", "track", "icon.png")).bytes()).toEqual(
      bytes,
    );
    expect((await install()).sync.unchanged).toEqual(["roadmap", "track"]);
  });

  test("a manifest naming anything but a skill directory stops sync before it touches anything", async () => {
    await put(join(repo(), ".agents", "skills", "mine", "SKILL.md"), "mine\n");
    await put(join(repo(), "keep", "data.txt"), "data\n");
    for (const name of ["", "..", "mine/..", "../../keep"]) {
      await put(
        join(repo(), ".agents", "skills", "monkeyshape.json"),
        JSON.stringify({ shared: [name] }),
      );
      const exit = await Effect.runPromiseExit(installSkills(shipped(), repo()));
      expect(Exit.isFailure(exit)).toBe(true);
      expect(await Bun.file(join(repo(), ".agents", "skills", "mine", "SKILL.md")).exists()).toBe(
        true,
      );
      expect(await Bun.file(join(repo(), "keep", "data.txt")).exists()).toBe(true);
      expect(
        await Bun.file(join(repo(), ".agents", "skills", "roadmap", "SKILL.md")).exists(),
      ).toBe(false);
    }
  });

  test("a package without skills installs none and still links", async () => {
    await rm(shipped(), { recursive: true });
    const result = await install();
    expect(result.sync.added).toEqual([]);
    expect(result.linked).toBe(true);
  });
});
