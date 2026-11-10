/**
 * `mshape track new`, `track current` and the track layout under links: real git, temp repos
 * with real worktrees, driven through the CLI. The shared harness is `./tracksHarness.ts`.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readlink, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHandoff } from "../../src/core/handoff.ts";
import {
  base,
  branches,
  exists,
  handoff,
  movedTo,
  mshape,
  repo,
  setup,
  sh,
  useTrackRepo,
  wt,
} from "./tracksHarness.ts";

useTrackRepo();

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
    expect("problems" in stub ? stub.problems : stub.stub).toBe(true);

    const again = mshape(repo, "new", "docs");
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("track `docs` exists");
  });

  test("installs dependencies in the new worktree; a failed install is a note, not a refusal", async () => {
    await setup();
    // A local dependency: bun links it without the network.
    await mkdir(join(repo, "local"));
    await writeFile(join(repo, "local", "package.json"), '{"name":"local","version":"1.0.0"}');
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({ name: "app", dependencies: { local: "file:./local" } }),
    );
    await writeFile(join(repo, ".gitignore"), "node_modules\n", { flag: "a" });
    expect(Bun.spawnSync([process.execPath, "install"], { cwd: repo }).exitCode).toBe(0);
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "deps");
    const made = mshape(repo, "new", "app");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("ran `bun install --frozen-lockfile` in");
    expect(await exists(`${wt("app")}/node_modules/local/package.json`)).toBe(true);

    // A lockfile that no longer matches package.json: frozen install fails, the track stands.
    await writeFile(
      join(repo, "package.json"),
      JSON.stringify({
        name: "app",
        dependencies: { local: "file:./local", other: "file:./local" },
      }),
    );
    sh(repo, "commit", "-qam", "drift");
    const drifted = mshape(repo, "new", "drift");
    expect(drifted.code).toBe(0);
    expect(drifted.stdout).toContain("note: `bun install --frozen-lockfile` failed in");
    expect(drifted.stdout).toContain("error: lockfile had changes");
    // Not the command that just failed: the fix the drift needs.
    expect(drifted.stdout).toContain(
      "the lockfile is out of date with package.json: run `bun install` there and commit the lockfile it updates",
    );
    expect(drifted.stdout).not.toContain("run it there");
    expect(drifted.stdout).toContain("uses the main checkout's tsc and biome");
    expect(sh(wt("drift"), "branch", "--show-current")).toBe("track/drift");
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

    // The next bead's local branch, or a detached HEAD: still the track, with a note.
    sh(wt("docs"), "switch", "-qc", "elsewhere");
    const elsewhere = mshape(wt("docs"), "current");
    expect(elsewhere).toMatchObject({ code: 0, stdout: "docs" });
    expect(elsewhere.stderr).toContain("is on branch `elsewhere`, not `track/docs`");
    sh(wt("docs"), "switch", "-q", "--detach");
    expect(mshape(wt("docs"), "current")).toMatchObject({ code: 0, stdout: "docs" });
    // track pr still refuses there: it pushes HEAD, and the next bead's work must not join the
    // PR. Until `prs` makes it push `track/<name>`'s tip whatever is checked out; then drop this.
    const pr = mshape(wt("docs"), "pr");
    expect(pr.code).toBe(1);
    expect(pr.stderr).toContain("not `track/docs`");

    // Named like a track and still pointing at this repo, but not where git registered it.
    mshape(repo, "new", "moved");
    await rename(wt("moved"), wt("renamed"));
    expect(mshape(wt("renamed"), "current").stderr).toContain("git has no worktree registered");
  });
});

describe("track new from upstream main", () => {
  test("starts from origin/main when it has merges main lacks; from main when they diverged", async () => {
    await setup();
    sh(base, "init", "-q", "--bare", "-b", "main", "remote.git");
    sh(repo, "remote", "add", "origin", join(base, "remote.git"));
    sh(repo, "push", "-q", "-u", "origin", "main");
    // A merge done on GitHub: a commit on the remote that local main hasn't pulled.
    sh(base, "clone", "-q", join(base, "remote.git"), "other");
    for (const key of ["user.name", "user.email"]) sh(join(base, "other"), "config", key, "x");
    sh(join(base, "other"), "commit", "-q", "--allow-empty", "-m", "merged on GitHub");
    sh(join(base, "other"), "push", "-q", "origin", "main");

    const made = mshape(repo, "new", "docs");
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("on `track/docs` from `origin/main`");
    expect(sh(wt("docs"), "log", "-1", "--format=%s")).toBe("merged on GitHub");
    expect(await Bun.file(handoff("docs")).text()).toContain("branched from `origin/main`.");
    // No upstream set on the track branch: its PR, not origin/main, is where it goes.
    const upstream = Bun.spawnSync(["git", "config", "--get", "branch.track/docs.merge"], {
      cwd: repo,
    });
    expect(upstream.exitCode).toBe(1);

    // A local commit too: diverged, so local main, and a note saying why.
    sh(repo, "commit", "-q", "--allow-empty", "-m", "local only");
    sh(join(base, "other"), "commit", "-q", "--allow-empty", "-m", "another merge");
    sh(join(base, "other"), "push", "-q", "origin", "main");
    const diverged = mshape(repo, "new", "init");
    expect(diverged.stdout).toContain(
      "note: `main` and `origin/main` have diverged (1 and 2 commits of their own), so the track starts from `main`",
    );
    expect(sh(wt("init"), "log", "-1", "--format=%s")).toBe("local only");
  });
});

describe("track new and a track branch left on the remote", () => {
  test("a stale origin/track/<name> from an earlier track is said, with the fix; a merged one isn't", async () => {
    await setup();
    sh(base, "init", "-q", "--bare", "-b", "main", "remote.git");
    sh(repo, "remote", "add", "origin", join(base, "remote.git"));
    sh(repo, "push", "-q", "-u", "origin", "main");

    // An earlier track pushed its branch, and its PR was squash-merged: the head branch stays.
    mshape(repo, "new", "docs");
    await writeFile(`${wt("docs")}/page.md`, "page\n");
    sh(wt("docs"), "add", ".");
    sh(wt("docs"), "commit", "-qm", "page");
    sh(wt("docs"), "push", "-q", "origin", "track/docs");
    sh(repo, "merge", "-q", "--squash", "track/docs");
    sh(repo, "commit", "-qm", "page (squashed)");
    sh(repo, "push", "-q", "origin", "main");
    expect(mshape(repo, "rm", "docs").code).toBe(0);

    const made = mshape(repo, "new", "docs");
    expect(made.code).toBe(0);
    const stale = sh(join(base, "remote.git"), "rev-parse", "track/docs").slice(0, 12);
    expect(made.stdout).toContain(
      `note: \`origin\` still has a \`track/docs\` (at ${stale}) that this track's start doesn't contain`,
    );
    expect(made.stdout).toContain("delete it: `git push origin --delete track/docs`");

    // Merged by a merge commit instead: main contains it, the push fast-forwards, no note.
    mshape(repo, "new", "notes");
    await writeFile(`${wt("notes")}/n.md`, "n\n");
    sh(wt("notes"), "add", ".");
    sh(wt("notes"), "commit", "-qm", "n");
    sh(wt("notes"), "push", "-q", "origin", "track/notes");
    sh(repo, "merge", "-q", "--no-edit", "track/notes");
    sh(repo, "push", "-q", "origin", "main");
    expect(mshape(repo, "rm", "notes").code).toBe(0);
    expect(mshape(repo, "new", "notes").stdout).not.toContain("still has a");
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
    movedTo(`${base}/moved/repo`);
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
