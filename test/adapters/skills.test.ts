import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { installSkills } from "../../src/adapters/skills.ts";

let dir = "";
const shipped = () => join(dir, "package", "skills");
const repo = () => join(dir, "repo");

const put = async (path: string, text: string) => {
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

  test("a package without skills installs none and still links", async () => {
    await rm(shipped(), { recursive: true });
    const result = await install();
    expect(result.sync.added).toEqual([]);
    expect(result.linked).toBe(true);
  });
});
