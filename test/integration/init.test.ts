/**
 * `mshape init` for real: pack this package, create a repo that installs the tarball, and run
 * the new repo's own gate. A second repo is created by the installed binary, so a template
 * file missing from package.json `files` fails here, not in an adopter's terminal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");

let work = "";
let tarball = "";

/** A CI runner has no git identity; init's first commit needs one. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const run = async (cwd: string, command: ReadonlyArray<string>) => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...IDENTITY },
  });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  return { code: await child.exited, output: `${stdout}${stderr}` };
};

const fromSource = (args: ReadonlyArray<string>) =>
  run(work, [process.execPath, join(ROOT, "src", "cli", "main.ts"), "init", ...args]);

const tracked = async (repo: string) =>
  (await run(repo, ["git", "ls-files"])).output.trim().split("\n").sort();

let created = { code: 0, output: "" };

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mshape-init-"));
  const packed = await Bun.$`bun pm pack --destination ${work} --quiet`.cwd(ROOT).text();
  tarball = join(work, packed.trim().split("\n").at(-1)?.split("/").at(-1) ?? "");
  created = await fromSource(["demo", "--from", tarball]);
}, 120_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("mshape init", () => {
  test("creates, installs and commits the repo, then prints the next step", () => {
    expect(created.output).toContain("Created demo/");
    expect(created.output).toContain("bun install");
    expect(created.output).toContain("first commit");
    expect(created.output).not.toContain("note:");
    expect(created.output).toContain("run /roadmap");
    expect(created.output).toContain("docs/workflow.md");
    expect(created.code).toBe(0);
  });

  test("the new repo is one clean commit, lockfile included", async () => {
    const repo = join(work, "demo");
    expect((await run(repo, ["git", "status", "--porcelain"])).output).toBe("");
    expect((await run(repo, ["git", "rev-list", "--count", "HEAD"])).output.trim()).toBe("1");
    expect((await run(repo, ["git", "branch", "--show-current"])).output.trim()).toBe("main");
    const files = await tracked(repo);
    for (const file of ["bun.lock", ".gitignore", "CLAUDE.md", "plan/.gitkeep", "notes/.gitkeep"])
      expect(files).toContain(file);
    expect(await Bun.file(join(repo, "CLAUDE.md")).text()).toBe("@AGENTS.md\n");
  });

  test("its gate passes empty, with nothing skipped", async () => {
    const check = await run(join(work, "demo"), [process.execPath, "run", "check"]);
    expect(check.output).toContain("mshape check passed");
    expect(check.output).not.toContain("note:");
    expect(check.code).toBe(0);
  }, 60_000);

  test("the installed package carries the template: its init makes the same repo", async () => {
    const bin = join(work, "demo", "node_modules", ".bin", "mshape");
    const again = await run(work, [process.execPath, bin, "init", "again", "--from", tarball]);
    expect(again.code).toBe(0);
    expect(await tracked(join(work, "again"))).toEqual(await tracked(join(work, "demo")));
  }, 60_000);

  test("refuses a name that is not lowercase words joined by hyphens", async () => {
    const result = await fromSource(["My_App"]);
    expect(result.output).toContain("lowercase words joined by hyphens");
    expect(result.code).toBe(2);
  });

  test("refuses a directory that is not empty, and leaves it alone", async () => {
    await mkdir(join(work, "taken"));
    await writeFile(join(work, "taken", "keep.txt"), "mine\n");
    const result = await fromSource(["taken"]);
    expect(result.output).toContain("not empty");
    expect(result.code).toBe(2);
    expect(await readdir(join(work, "taken"))).toEqual(["keep.txt"]);
  });
});
