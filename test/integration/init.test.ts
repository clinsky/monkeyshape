/**
 * `mshape init` for real: pack this package, create a repo that installs the tarball, and run
 * the new repo's own gate. A second repo is created by the installed binary, so a template
 * file missing from package.json `files` fails here, not in an adopter's terminal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

/** CI runners have no bd: the beads half of init is then covered only by the no-bd test. */
const HAS_BD = Bun.which("bd") !== null;

const run = async (
  cwd: string,
  command: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...IDENTITY, ...env },
  });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  return { code: await child.exited, output: `${stdout}${stderr}` };
};

/**
 * Notes init printed that this machine doesn't explain. Without bd (as in CI) the one expected
 * note is bd's; anything else, a failed install or format, fails everywhere.
 */
const unexpectedNotes = (output: string): ReadonlyArray<string> =>
  output
    .split("\n")
    .filter((line) => line.startsWith("note:"))
    .filter((line) => HAS_BD || !line.startsWith("note: bd is not on PATH"));

const fromSource = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  run(work, [process.execPath, join(ROOT, "src", "cli", "main.ts"), "init", ...args], env);

const tracked = async (repo: string) =>
  (await run(repo, ["git", "ls-files"])).output.trim().split("\n").sort();

let created = { code: 0, output: "" };

beforeAll(async () => {
  // A space in the path: the installed binary must find its template through it.
  work = await mkdtemp(join(tmpdir(), "mshape init "));
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
    expect(unexpectedNotes(created.output)).toEqual([]);
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

  test("commits .claude/skills as a relative symlink to .agents/skills (D-skills-link)", async () => {
    const repo = join(work, "demo");
    const entry = (await run(repo, ["git", "ls-files", "--stage", ".claude/skills"])).output;
    expect(entry).toStartWith("120000 ");
    const blob = entry.split(/\s+/)[1] ?? "";
    expect((await run(repo, ["git", "cat-file", "-p", blob])).output).toBe("../.agents/skills");
    expect(await realpath(join(repo, ".claude", "skills"))).toBe(
      await realpath(join(repo, ".agents", "skills")),
    );
  });

  test("mshape check reads the link from disk: an absolute one fails the skills check", async () => {
    const repo = join(work, "demo");
    const link = join(repo, ".claude", "skills");
    const mshape = [process.execPath, join(repo, "node_modules", ".bin", "mshape")];
    await rm(link);
    await symlink(join(await realpath(repo), ".agents", "skills"), link);
    let result = { code: 0, output: "" };
    try {
      result = await run(repo, [...mshape, "check", "--only", "skills"]);
    } finally {
      await rm(link);
      await symlink("../.agents/skills", link);
    }
    expect(result.output).toContain("skills/link");
    expect(result.output).toContain("absolute path");
    expect(result.code).toBe(1);
    expect((await run(repo, [...mshape, "check", "--only", "skills"])).code).toBe(0);
  });

  test("the handoffs store is under .git, behind relative, ignored links", async () => {
    const repo = join(work, "demo");
    const store = join(await realpath(repo), ".git", "monkeyshape", "handoffs");
    expect(await readdir(store)).toEqual([]);
    for (const link of [".handoffs", ".agents/handoffs"]) {
      expect(await readlink(join(repo, link))).not.toStartWith("/");
      expect(await realpath(join(repo, link))).toBe(store);
      expect((await run(repo, ["git", "check-ignore", link])).code).toBe(0);
    }
    expect((await run(repo, ["git", "check-ignore", ".agents/worktrees/x"])).code).toBe(0);
  });

  test.skipIf(!HAS_BD)(
    "beads is ready, its files are in the one commit, prime is capped",
    async () => {
      const repo = join(work, "demo");
      expect((await run(repo, ["bd", "ready"])).code).toBe(0);
      expect((await run(repo, ["bd", "config", "get", "prime.max-memories"])).output.trim()).toBe(
        "12",
      );
      expect(
        (await run(repo, ["bd", "config", "get", "prime.max-memory-chars"])).output.trim(),
      ).toBe("6144");
      expect(await tracked(repo)).toContain(".beads/config.yaml");
      expect(await Bun.file(join(repo, "AGENTS.md")).text()).not.toContain("BEGIN BEADS");
    },
  );

  test("without bd on PATH, init still succeeds and says how to finish", async () => {
    // A PATH with bun and git but no bd, as on a CI runner.
    const path = await mkdtemp(join(tmpdir(), "mshape-path-"));
    await symlink(process.execPath, join(path, "bun"));
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(path, "git"));
    const result = await fromSource(["no-beads", "--from", tarball], { PATH: path });
    await rm(path, { recursive: true, force: true });
    expect(result.output).toContain("note: bd is not on PATH");
    expect(result.output).toContain("bd init --skip-agents --non-interactive");
    expect(result.output).toContain("first commit");
    expect(result.code).toBe(0);
    expect(await Bun.file(join(work, "no-beads", ".beads", "config.yaml")).exists()).toBe(false);
  });

  test("its gate passes empty, with nothing skipped", async () => {
    const check = await run(join(work, "demo"), [process.execPath, "run", "check"]);
    expect(check.output).toContain("mshape check passed");
    expect(check.output).not.toContain("note:");
    expect(check.code).toBe(0);
  }, 60_000);

  test("the installed package carries the template: its init makes the same repo", async () => {
    const bin = join(work, "demo", "node_modules", ".bin", "mshape");
    const again = await run(work, [process.execPath, bin, "init", "--from", tarball, "again"]);
    expect(again.code).toBe(0);
    expect(unexpectedNotes(again.output)).toEqual([]);
    expect(await tracked(join(work, "again"))).toEqual(await tracked(join(work, "demo")));
  }, 60_000);

  test("refuses a name that is not lowercase words joined by hyphens", async () => {
    const result = await fromSource(["My_App"]);
    expect(result.output).toContain("lowercase words joined by hyphens");
    expect(result.code).toBe(2);
  });

  test("refuses --from without a value rather than installing from the registry", async () => {
    for (const args of [
      ["no-value", "--from"],
      ["--from", "--other", "no-value"],
    ]) {
      const result = await fromSource(args);
      expect(result.output).toContain("--from needs a value");
      expect(result.code).toBe(2);
    }
    expect(await Bun.file(join(work, "no-value", "package.json")).exists()).toBe(false);
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
