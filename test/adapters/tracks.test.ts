/**
 * `mshape track` against real git: temp repos with real worktrees, driven through the CLI.
 * Never the real repo's worktrees.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

const mshapeWith = (
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  ...args: ReadonlyArray<string>
) => {
  const result = Bun.spawnSync([process.execPath, CLI, "track", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
};

const mshape = (cwd: string, ...args: ReadonlyArray<string>) => mshapeWith({}, cwd, ...args);

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const branches = () => sh(repo, "branch", "--format=%(refname:lstrip=2)").split("\n").sort();
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
    expect(await readlink(`${wt("docs")}/data`)).toBe("../../../data");
    expect(await realpath(`${wt("docs")}/data`)).toBe(`${repo}/data`);
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
      ["docs", "stub", "-", "0", "yes", ".agents/worktrees/repo@docs"],
      ["init", "stub", "-", "1", "no", ".agents/worktrees/repo@init"],
    ]);
    expect(await realpath(`${repo}/.handoffs`)).toBe(`${repo}/.git/monkeyshape/handoffs`);

    // A dangling link of ours is replaced; one pointing at something real is left alone.
    await rm(`${wt("docs")}/.handoffs`);
    await symlink("../nowhere", `${wt("docs")}/.handoffs`);
    await rm(`${wt("init")}/.handoffs`);
    await mkdir(`${wt("init")}/.handoffs`);
    const repaired = mshape(repo, "list").stdout;
    expect(repaired).toContain(`relinked ${wt("docs")}/.handoffs`);
    expect(repaired).toContain(`note: ${wt("init")}/.handoffs exists but is not a link`);
    expect(await realpath(`${wt("docs")}/.handoffs`)).toBe(`${repo}/.git/monkeyshape/handoffs`);
  });

  test("an invalid handoff is listed with each problem under its row", async () => {
    await setup();
    mshape(repo, "new", "docs");
    mshape(repo, "new", "init");
    const text = await Bun.file(handoff("docs")).text();
    await writeFile(
      handoff("docs"),
      text.replace("Status: stub", "Status: done").replace("## Traps", "## Pitfalls"),
    );

    const lines = mshape(repo, "list").stdout.split("\n");
    const row = lines.findIndex((line) => line.startsWith("docs "));
    expect(lines[row]?.split(/\s+/)[1]).toBe("invalid");
    expect(lines[row + 1]).toBe(
      "  .handoffs/docs.md: `Status:` must be `stub` or `active`, found `done`",
    );
    expect(lines[row + 2]).toStartWith("  .handoffs/docs.md: sections must be exactly");
    expect(lines[row + 3]).toMatch(/^init\s+stub/);
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

  test("a tag named like the branch hides nothing: unmerged commits still refuse", async () => {
    await setup();
    mshape(repo, "new", "docs");
    await writeFile(`${wt("docs")}/a.md`, "a");
    sh(wt("docs"), "add", ".");
    sh(wt("docs"), "commit", "-qm", "a");
    // Short names resolve tags first: `main..track/docs` would count zero commits here.
    sh(repo, "tag", "track/docs", "main");

    const refused = mshape(repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("1 commit(s) not in `main`");
    expect(branches()).toEqual(["main", "track/docs"]);
    expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+-\s+1\s+no/m);
  });

  test("a stale registration of the branch elsewhere asks for a prune", async () => {
    await setup();
    sh(repo, "worktree", "add", "-q", "-b", "track/docs", `${base}/elsewhere`, "main");
    await rm(`${base}/elsewhere`, { recursive: true });
    const refused = mshape(repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("which no longer exists: run `git worktree prune`");
  });
});

describe("track layout under links", () => {
  test("a symlinked worktrees directory: links resolve; current, list and rm find the track", async () => {
    await setup(["data"]);
    await mkdir(join(repo, "data"));
    await mkdir(`${base}/disk`);
    await mkdir(`${repo}/.agents`);
    await symlink(`${base}/disk`, `${repo}/.agents/worktrees`);
    expect(mshape(repo, "new", "docs").code).toBe(0);
    expect(await exists(`${base}/disk/repo@docs`)).toBe(true);
    // The OS resolves a link from its real directory, here outside the repo.
    expect(await realpath(`${wt("docs")}/data`)).toBe(`${repo}/data`);
    expect(await realpath(`${wt("docs")}/.handoffs`)).toBe(`${repo}/.git/monkeyshape/handoffs`);

    expect(mshape(wt("docs"), "current")).toMatchObject({ code: 0, stdout: "docs" });
    expect(mshape(repo, "list").stdout).toContain(".agents/worktrees/repo@docs");
    expect(mshape(repo, "rm", "docs").code).toBe(0);
    expect(await exists(`${base}/disk/repo@docs`)).toBe(false);
  });

  test("handoff and shared-path links survive moving the repo", async () => {
    await setup(["data"]);
    await mkdir(join(repo, "data"));
    mshape(repo, "new", "docs");
    await mkdir(`${base}/moved`);
    await rename(repo, `${base}/moved/repo`);
    repo = `${base}/moved/repo`;
    sh(repo, "worktree", "repair", wt("docs"));
    expect(await realpath(`${wt("docs")}/data`)).toBe(`${repo}/data`);
    expect(await realpath(`${wt("docs")}/.handoffs`)).toBe(`${repo}/.git/monkeyshape/handoffs`);
    expect(mshape(wt("docs"), "current").stdout).toBe("docs");
  });

  test("a failure after the worktree exists says what was done and how to undo it", async () => {
    await setup();
    const store = `${repo}/.git/monkeyshape/handoffs`;
    await mkdir(store, { recursive: true });
    await chmod(store, 0o555);
    const stopped = mshape(repo, "new", "docs");
    await chmod(store, 0o755);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain("track new docs: stopped: write");
    expect(stopped.stderr).toContain(`done: created ${wt("docs")} on \`track/docs\``);
    expect(stopped.stderr).toContain("undo with `mshape track rm docs`");

    expect(mshape(repo, "rm", "docs").code).toBe(0);
    expect(mshape(repo, "new", "docs").code).toBe(0);
  });
});

/**
 * Open beads hold a track. A fake `bd` on PATH prints the rows these tests give it, so they run
 * where bd isn't installed (CI); the last test uses the real one when it is.
 */
describe("track rm and list with beads", () => {
  const bead = (id: string, status: string, labels: ReadonlyArray<string>) => ({
    id,
    title: `bead ${id}`,
    status,
    labels,
  });

  /** Beads set up in the repo, and a fake bd printing `rows` (exiting `exit`). */
  const fakeBd = async (rows: ReadonlyArray<unknown>, exit = 0) => {
    await mkdir(`${repo}/.beads`, { recursive: true });
    await writeFile(`${repo}/.beads/config.yaml`, "");
    await mkdir(`${base}/bin`, { recursive: true });
    await writeFile(`${base}/rows.json`, JSON.stringify(rows));
    await writeFile(`${base}/bin/bd`, `#!/bin/sh\ncat "${base}/rows.json"\nexit ${exit}\n`);
    await chmod(`${base}/bin/bd`, 0o755);
    return { PATH: `${base}/bin:${process.env["PATH"] ?? ""}` };
  };

  test("open beads refuse, even with --force, touching nothing; once closed, rm goes ahead", async () => {
    await setup();
    mshape(repo, "new", "docs");
    const env = await fakeBd([
      bead("x-1", "in_progress", ["track:docs"]),
      bead("x-2", "closed", ["track:docs"]),
      bead("x-3", "open", ["track:init"]),
    ]);
    for (const flags of [[], ["--force"]]) {
      const refused = mshapeWith(env, repo, "rm", "docs", ...flags);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("`track:docs` still labels 1 bead(s) that aren't closed");
      expect(refused.stderr).toContain("x-1 (in_progress) bead x-1");
      expect(refused.stderr).not.toContain("x-2");
    }
    expect(await exists(wt("docs"))).toBe(true);
    expect(branches()).toEqual(["main", "track/docs"]);

    const listed = mshapeWith(env, repo, "list").stdout;
    expect(listed).toMatch(/^docs\s+stub\s+1\s+0\s+yes/m);
    // A label with open beads and nothing else: work filed for a track that doesn't exist.
    expect(listed).toMatch(/^init\s+none\s+1\s+-\s+-\s+-$/m);

    const closed = await fakeBd([bead("x-1", "closed", ["track:docs"])]);
    expect(mshapeWith(closed, repo, "rm", "docs").code).toBe(0);
    expect(await exists(wt("docs"))).toBe(false);
  });

  test("bd failing refuses under the default config, even with --force; list notes it", async () => {
    await setup();
    mshape(repo, "new", "docs");
    // The open bead is there, but bd can't show it: removing the track would orphan it unseen.
    const broken = await fakeBd([bead("x-1", "open", ["track:docs"])], 1);
    for (const flags of [[], ["--force"]]) {
      const refused = mshapeWith(broken, repo, "rm", "docs", ...flags);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(
        "bd failed, so the open beads labelled `track:docs` can't be seen",
      );
    }
    expect(await exists(wt("docs"))).toBe(true);
    expect(branches()).toEqual(["main", "track/docs"]);
    expect(mshapeWith(broken, repo, "list").stdout).toContain("note: open beads not counted");
  });

  test("bd not installed: a note when beads is optional, a refusal when required", async () => {
    await setup();
    mshape(repo, "new", "docs");
    await fakeBd([]);
    // A PATH with git and nothing else: the CLI spawns only git and bd.
    await mkdir(`${base}/git-only`);
    await symlink(Bun.which("git") ?? "git", `${base}/git-only/git`);
    const noBd = { PATH: `${base}/git-only` };

    await writeFile(join(repo, "shape.config.ts"), `export default { beads: "required" };\n`);
    const refused = mshapeWith(noBd, repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("requires beads, but bd is not on PATH");
    expect(await exists(wt("docs"))).toBe(true);

    await writeFile(join(repo, "shape.config.ts"), "export default {};\n");
    const noted = mshapeWith(noBd, repo, "rm", "docs");
    expect(noted.code).toBe(0);
    expect(noted.stderr).toContain("note: open beads were not checked: bd is not on PATH");
  });

  test("a repo without beads says it didn't check", async () => {
    await setup();
    mshape(repo, "new", "docs");
    const removed = mshape(repo, "rm", "docs");
    expect(removed.code).toBe(0);
    expect(removed.stderr).toContain("note: this repo has no beads");
  });

  test.skipIf(Bun.which("bd") === null)(
    "with the real bd: an open bead labelled for the track refuses until it is closed",
    async () => {
      await setup();
      const bd = (...args: ReadonlyArray<string>) => {
        const result = Bun.spawnSync(["bd", ...args], {
          cwd: repo,
          stdout: "pipe",
          stderr: "pipe",
        });
        if (result.exitCode !== 0) throw new Error(`bd ${args.join(" ")}: ${result.stderr}`);
        return result.stdout.toString().trim();
      };
      bd("init", "-q", "--skip-agents", "--prefix", "t");
      mshape(repo, "new", "docs");
      const id = bd("create", "--title", "left behind", "--labels", "track:docs", "--silent");

      const refused = mshape(repo, "rm", "docs");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`${id} (open) left behind`);
      expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+1\s/m);

      bd("close", id);
      expect(mshape(repo, "rm", "docs").code).toBe(0);
    },
    30_000,
  );
});
