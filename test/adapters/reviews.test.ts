/**
 * `mshape review` against real git: a bare `origin` publishing a pull request as
 * `refs/pull/<n>/head`, as GitHub does, and a clone whose worktrees the CLI makes. Never the
 * real repo's worktrees.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let base = "";
let repo = "";

const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

const mshape = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
};

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const wt = (pr: number) => `${repo}/.agents/worktrees/repo.pr-${pr}`;

/** The author's clone commits `file` on top of main and publishes it as pull request `pr`. */
const publish = async (pr: number, file: string, text = "x\n") => {
  const author = join(base, "author");
  if (!(await exists(author))) sh(base, "clone", "-q", join(base, "origin.git"), "author");
  sh(author, "fetch", "-q", "origin", "main");
  sh(author, "switch", "-q", "--detach", "origin/main");
  await mkdir(join(author, file, ".."), { recursive: true });
  await writeFile(join(author, file), text);
  sh(author, "add", "-f", file);
  sh(
    author,
    "-c",
    "user.name=Author",
    "-c",
    "user.email=a@example.com",
    "commit",
    "-qm",
    `pr ${pr}`,
  );
  sh(author, "push", "-q", "-f", "origin", `HEAD:refs/pull/${pr}/head`);
  return sh(author, "rev-parse", "HEAD");
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-reviews-")));
  sh(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ])
    sh(repo, "config", key ?? "", value ?? "");
  sh(repo, "remote", "add", "origin", join(base, "origin.git"));
  await writeFile(
    join(repo, "shape.config.ts"),
    `export default ${JSON.stringify({ tracks: { sharedPaths: ["data"] } })};\n`,
  );
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.handoffs\ndata\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  sh(repo, "push", "-q", "origin", "main");
  await mkdir(join(repo, "data"));
  await writeFile(join(repo, "data", "big.bin"), "dataset\n");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("review", () => {
  test("the head, detached, with shared data linked; not a track", async () => {
    const head = await publish(7, "src/a.ts");
    const made = mshape(repo, "review", "7");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(`created ${wt(7)} at the head of #7: ${head}`);
    expect(sh(wt(7), "rev-parse", "HEAD")).toBe(head);
    expect(sh(wt(7), "branch", "--show-current")).toBe("");
    expect(await readFile(join(wt(7), "data", "big.bin"), "utf8")).toBe("dataset\n");
    expect(sh(repo, "branch", "--format=%(refname:short)")).toBe("main");

    expect(mshape(repo, "track", "list").stdout).not.toContain("pr-7");
    const current = mshape(wt(7), "track", "current");
    expect(current.code).toBe(1);
  });

  test("again after a push: moved to the new head, printing the old one", async () => {
    const first = await publish(7, "src/a.ts");
    mshape(repo, "review", "7");
    expect(mshape(repo, "review", "7").stdout).toContain("is already at the head of #7");
    const second = await publish(7, "src/a.ts", "fixed\n");
    const moved = mshape(wt(7), "review", "7");
    expect(moved.code).toBe(0);
    expect(moved.stdout).toContain(`moved ${wt(7)} to the head of #7: ${second}`);
    expect(moved.stdout).toContain(`previous head: ${first}`);
    expect(sh(wt(7), "rev-parse", "HEAD")).toBe(second);
  });

  test("rm lists what it discards and removes worktree and ref, never the shared data", async () => {
    await publish(7, "src/a.ts");
    mshape(repo, "review", "7");
    await writeFile(join(wt(7), "probe.ts"), "scratch\n");
    const removed = mshape(repo, "review", "rm", "7");
    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain("discarding in");
    expect(removed.stderr).toContain("probe.ts");
    expect(await exists(wt(7))).toBe(false);
    expect(sh(repo, "for-each-ref", "refs/monkeyshape/")).toBe("");
    expect(await readFile(join(repo, "data", "big.bin"), "utf8")).toBe("dataset\n");
    expect(mshape(repo, "review", "rm", "7").stdout).toBe("no review of #7 here; nothing removed");
  });

  test("a bad number, or a pull request origin doesn't have, creates nothing", async () => {
    expect(mshape(repo, "review", "seven").code).toBe(1);
    const missing = mshape(repo, "review", "99");
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("could not fetch pull request #99");
    expect(await exists(wt(99))).toBe(false);
    expect(mshape(repo, "review").code).toBe(2);
  });

  test("a directory at the path that git doesn't know is refused and left alone", async () => {
    await publish(7, "src/a.ts");
    await mkdir(wt(7), { recursive: true });
    await writeFile(join(wt(7), "mine.txt"), "keep\n");
    expect(mshape(repo, "review", "7").code).toBe(1);
    expect(mshape(repo, "review", "rm", "7").code).toBe(1);
    expect(await readFile(join(wt(7), "mine.txt"), "utf8")).toBe("keep\n");
  });

  test("a shared path the pull request tracks is not linked, with a note", async () => {
    await publish(7, "data/big.bin", "tracked\n");
    const made = mshape(repo, "review", "7");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("shared path `data` is tracked at the head of #7; not linked");
    expect(await readFile(join(wt(7), "data", "big.bin"), "utf8")).toBe("tracked\n");
    expect(await readFile(join(repo, "data", "big.bin"), "utf8")).toBe("dataset\n");
  });
});
