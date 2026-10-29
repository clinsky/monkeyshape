/**
 * `mshape track` against real git: temp repos with real worktrees, driven through the CLI.
 * Never the real repo's worktrees.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readlink, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHandoff } from "../../src/core/handoff.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let base = "";
let repo = "";

const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

const mshape = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, "track", ...args], {
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

const branches = () => sh(repo, "branch", "--format=%(refname:short)").split("\n").sort();
const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
const handoff = (track: string) => `${repo}/.git/monkeyshape/handoffs/${track}.md`;

const setup = async (sharedPaths: ReadonlyArray<string> = []) => {
  await writeFile(
    join(repo, "shape.config.ts"),
    `export default ${JSON.stringify({ tracks: { sharedPaths } })};\n`,
  );
  await writeFile(
    join(repo, ".gitignore"),
    ".agents/worktrees/\n.agents/handoffs\n.handoffs\ndata\n",
  );
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-tracks-")));
  repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("track new", () => {
  test("creates the worktree, branch, handoff links, shared links and a stub; a second call refuses", async () => {
    await setup(["data", "cases"]);
    await mkdir(join(repo, "data"));
    await writeFile(join(repo, "data", "big.bin"), "x");
    const made = mshape(repo, "new", "docs");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("note: shared path `cases` is missing");
    expect(sh(wt("docs"), "branch", "--show-current")).toBe("track/docs");
    expect(await readlink(`${wt("docs")}/data`)).toBe(`${repo}/data`);
    expect(await exists(`${wt("docs")}/cases`)).toBe(false);
    for (const link of [`${wt("docs")}/.handoffs`, `${repo}/.handoffs`, `${repo}/.agents/handoffs`])
      expect(await realpath(link)).toBe(`${repo}/.git/monkeyshape/handoffs`);
    const stub = parseHandoff(await Bun.file(handoff("docs")).text());
    expect("problems" in stub ? stub.problems : stub.status).toBe("stub");

    const again = mshape(repo, "new", "docs");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("track `docs` exists");
  });

  test("from inside a worktree, the new track still lands under the main checkout", async () => {
    await setup();
    expect(mshape(repo, "new", "a").code).toBe(0);
    expect(mshape(`${wt("a")}`, "new", "b").code).toBe(0);
    expect(await exists(wt("b"))).toBe(true);
    expect(await exists(`${wt("a")}/.agents/worktrees`)).toBe(false);
  });

  test("bad shared-path lists and names are refused before anything is created", async () => {
    for (const shared of [["data", "data"], ["data", "data/large"], [".handoffs/x"], [".git"]]) {
      await setup(shared);
      const refused = mshape(repo, "new", "docs");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("tracks.sharedPaths");
      expect(await exists(wt("docs"))).toBe(false);
      expect(branches()).toEqual(["main"]);
    }
    expect(mshape(repo, "new", "Docs").stderr).toContain("is not a track name");
  });

  test("a shared path tracked in main is refused before anything is created", async () => {
    await setup(["fixtures/cases"]);
    await mkdir(join(repo, "fixtures"));
    await writeFile(join(repo, "fixtures", "cases"), "tracked");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "tracked");
    const refused = mshape(repo, "new", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("is tracked in `main`");
    expect(branches()).toEqual(["main"]);
  });
});

describe("track current", () => {
  test("the name from a worktree or below it; exit 1 elsewhere, saying which check failed", async () => {
    await setup();
    mshape(repo, "new", "docs");
    await mkdir(`${wt("docs")}/sub`);
    expect(mshape(wt("docs"), "current")).toMatchObject({ code: 0, stdout: "docs" });
    expect(mshape(`${wt("docs")}/sub`, "current")).toMatchObject({ code: 0, stdout: "docs" });

    const main = mshape(repo, "current");
    expect(main.code).toBe(1);
    expect(main.stdout).toBe("");
    expect(main.stderr).toContain("is not a track worktree");

    sh(wt("docs"), "switch", "-qc", "elsewhere");
    expect(mshape(wt("docs"), "current").stderr).toContain("not `track/docs`");

    // Named like a track and still pointing at this repo, but not where git registered it.
    mshape(repo, "new", "moved");
    await rename(wt("moved"), wt("renamed"));
    expect(mshape(wt("renamed"), "current").stderr).toContain("git has no worktree registered");
  });
});

describe("track list", () => {
  test("lists every track; handoffs survive git clean -fdx and list restores the links", async () => {
    await setup();
    mshape(repo, "new", "docs");
    mshape(repo, "new", "init");
    await writeFile(`${wt("init")}/x.txt`, "x");
    sh(wt("init"), "add", ".");
    sh(wt("init"), "commit", "-qm", "work");

    sh(repo, "clean", "-qfdx");
    expect(await exists(`${repo}/.agents/handoffs`)).toBe(false);
    expect(await exists(`${repo}/.handoffs`)).toBe(false);
    expect(await exists(handoff("docs"))).toBe(true);

    const listed = mshape(wt("docs"), "list");
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(`linked ${repo}/.agents/handoffs`);
    const rows = listed.stdout.split("\n").filter((line) => /^(docs|init) /.test(line));
    expect(rows.map((row) => row.split(/\s+/))).toEqual([
      ["docs", "stub", "0", "yes", ".agents/worktrees/repo@docs"],
      ["init", "stub", "1", "no", ".agents/worktrees/repo@init"],
    ]);
    expect(await realpath(`${repo}/.handoffs`)).toBe(`${repo}/.git/monkeyshape/handoffs`);
  });
});

describe("track rm", () => {
  test("a clean, merged track: worktree, branch and handoff go; main, others and shared data stay", async () => {
    await setup(["data"]);
    await mkdir(join(repo, "data"));
    await writeFile(join(repo, "data", "big.bin"), "x");
    mshape(repo, "new", "docs");
    mshape(repo, "new", "other");
    await writeFile(`${wt("docs")}/page.md`, "page");
    sh(wt("docs"), "add", ".");
    sh(wt("docs"), "commit", "-qm", "page");
    sh(repo, "merge", "-q", "--no-edit", "track/docs");

    const removed = mshape(repo, "rm", "docs");
    expect(removed.code).toBe(0);
    expect(await exists(wt("docs"))).toBe(false);
    expect(await exists(handoff("docs"))).toBe(false);
    expect(branches()).toEqual(["main", "track/other"]);
    expect(await exists(join(repo, "data", "big.bin"))).toBe(true);
    expect(await exists(wt("other"))).toBe(true);
    expect(await exists(handoff("other"))).toBe(true);
    expect(await exists(`${repo}/.git/monkeyshape/handoffs`)).toBe(true);
    expect(sh(repo, "worktree", "list", "--porcelain")).not.toContain("repo@docs");

    expect(mshape(repo, "rm", "docs").stderr).toContain("there is no track `docs`");
  });

  test("uncommitted or untracked changes and unmerged commits refuse, touching nothing", async () => {
    await setup();
    mshape(repo, "new", "docs");
    await writeFile(`${wt("docs")}/draft.md`, "draft");
    const dirty = mshape(repo, "rm", "docs");
    expect(dirty.code).toBe(1);
    expect(dirty.stderr).toContain("uncommitted or untracked changes (?? draft.md)");

    sh(wt("docs"), "add", ".");
    sh(wt("docs"), "commit", "-qm", "draft");
    const unmerged = mshape(repo, "rm", "docs");
    expect(unmerged.code).toBe(1);
    expect(unmerged.stderr).toContain("1 commit(s) not in `main`");
    expect(await exists(wt("docs"))).toBe(true);
    expect(await exists(handoff("docs"))).toBe(true);
    expect(branches()).toEqual(["main", "track/docs"]);
  });

  test("--force discards changes and unmerged commits, saying so first; --keep-handoff keeps it", async () => {
    await setup();
    mshape(repo, "new", "docs");
    await writeFile(`${wt("docs")}/a.md`, "a");
    sh(wt("docs"), "add", ".");
    sh(wt("docs"), "commit", "-qm", "a");
    await writeFile(`${wt("docs")}/b.md`, "b");

    const forced = mshape(repo, "rm", "docs", "--force", "--keep-handoff");
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain("--force: discarding uncommitted changes");
    expect(forced.stderr).toContain(
      "--force: deleting `track/docs` with 1 commit(s) not in `main`",
    );
    expect(await exists(wt("docs"))).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(await exists(handoff("docs"))).toBe(true);
    expect(forced.stdout).toContain("kept handoff");
  });

  test("a failure partway stops, reports what was removed and what remains; a rerun finishes", async () => {
    await setup();
    mshape(repo, "new", "docs");
    // A held ref lock makes deleting the branch, the second step, fail.
    const lock = `${repo}/.git/refs/heads/track/docs.lock`;
    await writeFile(lock, "");

    const stopped = mshape(repo, "rm", "docs");
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("stopped at branch `track/docs`");
    expect(stopped.stderr).toContain(`removed: worktree ${wt("docs")}`);
    expect(stopped.stderr).toContain(`remains: branch \`track/docs\`, handoff ${handoff("docs")}`);
    expect(await exists(wt("docs"))).toBe(false);
    expect(branches()).toEqual(["main", "track/docs"]);
    expect(await exists(handoff("docs"))).toBe(true);

    await rm(lock);
    const finished = mshape(repo, "rm", "docs");
    expect(finished.code).toBe(0);
    expect(branches()).toEqual(["main"]);
    expect(await exists(handoff("docs"))).toBe(false);
  });

  test("never removes a worktree on another branch, or a branch checked out elsewhere", async () => {
    await setup();
    mshape(repo, "new", "docs");
    sh(wt("docs"), "switch", "-qc", "elsewhere");
    expect(mshape(repo, "rm", "docs", "--force").stderr).toContain("is on `elsewhere`");
    expect(await exists(wt("docs"))).toBe(true);

    sh(wt("docs"), "switch", "-q", "track/docs");
    sh(repo, "switch", "-q", "elsewhere");
    sh(wt("docs"), "switch", "-q", "--detach");
    sh(repo, "switch", "-q", "track/docs");
    expect(mshape(repo, "rm", "docs", "--force").stderr).toContain(
      `\`track/docs\` is checked out at ${repo}`,
    );
    expect(branches()).toContain("track/docs");
  });
});
