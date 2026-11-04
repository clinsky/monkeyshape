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
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { patchMerged } from "../../src/adapters/tracks.ts";
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
    // rm reads Claude Code's sessions: a scratch directory, never the real ~/.claude.
    // A fake gh (`fakeGh`), never the real one: list reads PRs from GitHub.
    env: {
      ...process.env,
      PATH: `${base}/fake-gh:${process.env["PATH"] ?? ""}`,
      CLAUDE_CONFIG_DIR: join(base, "no-claude"),
      ...env,
    },
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
  await fakeGh([]);
});

/** `gh pr list` prints these PRs (JSON); `fakeGh(undefined)` makes gh fail like a repo with no remote. */
const fakeGh = async (prs: ReadonlyArray<object> | undefined) => {
  await mkdir(`${base}/fake-gh`, { recursive: true });
  await writeFile(
    `${base}/fake-gh/gh`,
    prs === undefined
      ? "#!/bin/sh\necho 'no git remotes found' >&2\nexit 1\n"
      : `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(prs)}\nEOF\n`,
  );
  await chmod(`${base}/fake-gh/gh`, 0o755);
};

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
    expect("problems" in stub ? stub.problems : stub.stub).toBe(true);

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
      // No PR has merged from either, so neither is done, whatever bd would say.
      ["docs", "stub", "-", "0", "yes", "no", ".agents/worktrees/repo@docs"],
      ["init", "stub", "-", "1", "no", "no", ".agents/worktrees/repo@init"],
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
      text.replace("Queue:", "Owner: me\nQueue:").replace("## Traps", "## Pitfalls"),
    );

    const lines = mshape(repo, "list").stdout.split("\n");
    const row = lines.findIndex((line) => line.startsWith("docs "));
    expect(lines[row]?.split(/\s+/)[1]).toBe("invalid");
    expect(lines[row + 1]).toBe(
      "  .handoffs/docs.md: only `Queue:` goes between the title and `## Charter`; found `Owner: me`",
    );
    expect(lines[row + 2]).toStartWith("  .handoffs/docs.md: sections must be exactly");
    expect(lines[row + 3]).toMatch(/^init\s+stub/);
  });

  test("an older handoff is migrated once, its Messages mailed to the track from main", async () => {
    await setup();
    mshape(repo, "new", "docs");
    mshape(repo, "new", "init");
    const text = await Bun.file(handoff("docs")).text();
    const charter = "Serves: goal 2, because x.\nOut of scope: y.\nDone means: z.";
    const current = text.replace("## Charter", `## Charter\n\n${charter}`);
    await writeFile(
      handoff("docs"),
      `${current.replace("Queue:", "Status: active\nQueue:")}\n## Messages\n\n- From init: hello.\n`,
    );
    const initText = await Bun.file(handoff("init")).text();
    await writeFile(handoff("init"), `${initText}\n## Messages\n\nNone yet.\n`);

    const first = mshape(repo, "list").stdout;
    expect(first).toMatch(
      /^migrated \.handoffs\/docs\.md: moved `## Messages` into the track's mailbox; removed `Status: active` \(message \d{8}-\d{6}-[0-9a-f]{4}\)$/m,
    );
    expect(first).toContain(
      "migrated .handoffs/init.md: removed `## Messages`, which held nothing\n",
    );
    expect(first).toMatch(/^docs\s+active\s/m);
    expect(first).toMatch(/^init\s+stub\s/m);
    expect(await Bun.file(handoff("docs")).text()).toBe(current);
    expect(await Bun.file(handoff("init")).text()).toBe(initText);

    const mail = await readdir(`${repo}/.git/monkeyshape/mail/docs`);
    const files = mail.filter((file) => file.endsWith(".json"));
    expect(files).toHaveLength(1);
    const message = JSON.parse(
      await Bun.file(`${repo}/.git/monkeyshape/mail/docs/${files[0]}`).text(),
    );
    expect(message.from).toBe("main");
    expect(message.subject).toBe("Messages carried over from your handoff");
    expect(message.body).toStartWith("- From init: hello.\n\n");

    const second = mshape(repo, "list").stdout;
    expect(second).not.toContain("migrated");
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

  test("unread mail refuses rm; read or forced, the mailbox goes, so a new track of the name starts empty", async () => {
    await setup();
    mshape(repo, "new", "docs");
    const msg = (cwd: string, ...args: ReadonlyArray<string>) => {
      const result = Bun.spawnSync([process.execPath, CLI, "msg", ...args], {
        cwd,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "" },
        stdout: "pipe",
        stderr: "pipe",
      });
      return result.stdout.toString();
    };
    const id = (sent: string) => /^Sent (\S+)/.exec(sent)?.[1] ?? "";
    const first = id(msg(repo, "send", "docs", "--subject", "first", "body"));
    const second = id(msg(repo, "send", "docs", "--subject", "second", "body"));
    msg(wt("docs"), "read", first);

    const refused = mshape(repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "1 message(s) to `docs` are unread, and removing the track would delete them:",
    );
    expect(refused.stderr).toContain(`${second} from main: second`);
    expect(await exists(wt("docs"))).toBe(true);

    const forced = mshape(repo, "rm", "docs", "--force");
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain(
      `--force: deleting 1 unread message(s):\n    ${second} from main: second`,
    );
    expect(forced.stdout).toContain(
      `removed mailbox ${repo}/.git/monkeyshape/mail/docs (1 unread, 1 read)`,
    );
    expect(await exists(`${repo}/.git/monkeyshape/mail/docs`)).toBe(false);

    mshape(repo, "new", "docs");
    expect(msg(wt("docs"), "inbox")).not.toContain("second");
    expect(await exists(`${repo}/.git/monkeyshape/mail/docs`)).toBe(false);
  });

  test("a running Claude Code session refuses rm; --force removes the track and its registry", async () => {
    await setup();
    mshape(repo, "new", "docs");
    // A fake Claude Code: this test's own process, as a session running in the worktree, and
    // registered for the track. Never the real ~/.claude, whose registry rm would prune.
    const claude = join(base, "claude");
    await mkdir(`${claude}/sessions`, { recursive: true });
    const session = "00000000-0000-4000-8000-000000000001";
    await writeFile(
      `${claude}/sessions/${process.pid}.json`,
      JSON.stringify({
        pid: process.pid,
        cwd: wt("docs"),
        sessionId: session,
        procStart: "p",
        peerProtocol: 1,
        messagingSocketPath: join(base, "none.sock"),
      }),
    );
    const registry = `${repo}/.git/monkeyshape/sessions/docs`;
    await mkdir(registry, { recursive: true });
    await writeFile(
      `${registry}/${session}.json`,
      JSON.stringify({ session, pid: process.pid, registered: "2026-01-01T00:00:00.000Z" }),
    );
    const env = { CLAUDE_CONFIG_DIR: claude };

    const refused = mshapeWith(env, repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `1 Claude Code session(s) still running in \`docs\` would lose their worktree: ${session}. Quit each one (\`/exit\`), or pass --force`,
    );
    expect(await exists(wt("docs"))).toBe(true);

    const forced = mshapeWith(env, repo, "rm", "docs", "--force");
    expect(forced.code).toBe(0);
    expect(forced.stderr).toContain(
      `--force: removing the track from under 1 running Claude Code session(s): ${session}`,
    );
    expect(forced.stdout).toContain("removed 1 session registration(s)");
    expect(await exists(registry)).toBe(false);
    expect(await exists(wt("docs"))).toBe(false);
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
    return { PATH: `${base}/bin:${base}/fake-gh:${process.env["PATH"] ?? ""}` };
  };

  test("a track just made is not done, and isn't told to be removed", async () => {
    // The probe from #39's review: real-looking facts all say yes for a branch at main.
    await setup();
    mshape(repo, "new", "fresh");
    const env = await fakeBd([]);
    const listed = mshapeWith(env, repo, "list").stdout;
    expect(listed).toMatch(/^fresh\s+stub\s+0\s+0\s+yes\s+no\s/m);
    expect(listed).not.toContain("remove it with");
  });

  test("a merged PR's bead deferred with what is left is settled: no warning, and done", async () => {
    // The probe from #39's round 4: the agent follows the advice, defers the bead and drops
    // the track's label, as beads/deferred-in-track asks. Nothing may keep the track at no.
    await setup();
    mshape(repo, "new", "fresh");
    const merged = {
      number: 9,
      state: "MERGED",
      headRefName: "track/fresh",
      body: "## Beads\n\n- x-1 part of it\n",
      createdAt: new Date().toISOString(),
    };
    await fakeGh([merged]);
    const open = await fakeBd([bead("x-1", "in_progress", ["track:fresh"])]);
    expect(mshapeWith(open, repo, "list").stdout).toContain(
      "x-1 (in_progress) is listed in merged PR #9",
    );

    const deferred = await fakeBd([bead("x-1", "deferred", [])]);
    const listed = mshapeWith(deferred, repo, "list").stdout;
    expect(listed).not.toContain("merged PR #9");
    expect(listed).toMatch(/^fresh\s+stub\s+0\s+0\s+yes\s+yes\s/m);
  });

  test("a reused name doesn't inherit the earlier track's PRs: not done, no warnings of theirs", async () => {
    // The probe from #39's re-review: rm, then new with the same name, while gh still lists
    // the first track's merged PR, whose bead is open.
    await setup();
    mshape(repo, "new", "fresh");
    const env = await fakeBd([bead("x-1", "open", [])]);
    const earlier = {
      number: 3,
      state: "MERGED",
      headRefName: "track/fresh",
      body: "## Beads\n\n- x-1\n",
      // Opened during the first track's life, which started just above.
      createdAt: new Date().toISOString(),
    };
    await fakeGh([earlier]);
    expect(mshapeWith(env, repo, "list").stdout).toContain("x-1 (open) is listed in merged PR #3");
    expect(mshapeWith(env, repo, "rm", "fresh").code).toBe(0);
    mshape(repo, "new", "fresh");

    const listed = mshapeWith(env, repo, "list").stdout;
    expect(listed).toMatch(/^fresh\s+stub\s+0\s+0\s+yes\s+no\s/m);
    expect(listed).not.toContain("merged PR #3");
    expect(listed).not.toContain("remove it with");
    expect(sh(repo, "config", "--get", "branch.track/fresh.mshape-started")).toMatch(/^\d{4}-/);
  });

  test("--keep-beads on a track whose start can't be placed says to record it, not to fix gh (z2m)", async () => {
    await setup();
    mshape(repo, "new", "old");
    // A long-lived track made before the start was recorded, its reflog since expired.
    sh(repo, "config", "--unset", "branch.track/old.mshape-started");
    sh(repo, "reflog", "expire", "--expire=now", "--all");
    const env = await fakeBd([bead("x-1", "open", ["track:old"])]);
    await fakeGh([
      {
        number: 1,
        state: "MERGED",
        headRefName: "track/old",
        body: "",
        createdAt: "2026-11-01T00:00:00Z",
      },
    ]);
    const refused = mshapeWith(env, repo, "rm", "old", "--keep-beads");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "Record when it started (`git config branch.track/old.mshape-started <YYYY-MM-DD>`): if unsure, a later date is safe",
    );
    expect(refused.stderr).not.toContain("gh auth status");
    // Recorded, as the refusal says: the merged PR is its own, and the bead is handed on.
    sh(repo, "config", "branch.track/old.mshape-started", "2026-10-31");
    expect(mshapeWith(env, repo, "rm", "old", "--keep-beads").code).toBe(0);
  });

  test("a reflog git expired in part doesn't date the start: only the branch's creation does (#48)", async () => {
    // The probe from #48's review: made 200 days ago, a commit 10 days ago, merged, and git's
    // default 90-day expiry has dropped the creation entry but kept the recent one.
    await setup();
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const git = (env: Record<string, string>, cwd: string, ...args: ReadonlyArray<string>) =>
      Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...env } });
    mshapeWith({ GIT_COMMITTER_DATE: daysAgo(200) }, repo, "new", "old");
    sh(repo, "config", "--unset", "branch.track/old.mshape-started");
    await writeFile(`${wt("old")}/b.md`, "b\n");
    sh(wt("old"), "add", ".");
    git(
      { GIT_COMMITTER_DATE: daysAgo(10), GIT_AUTHOR_DATE: daysAgo(10) },
      wt("old"),
      "commit",
      "-qm",
      "b",
    );
    sh(repo, "merge", "-q", "--no-edit", "track/old");
    sh(repo, "reflog", "expire", "--expire=90.days.ago", "--all");
    expect(sh(repo, "log", "--walk-reflogs", "--format=%gs", "track/old")).not.toContain(
      "Created from",
    );

    const env = await fakeBd([bead("x-1", "open", ["track:old"])]);
    await fakeGh([
      { number: 7, state: "MERGED", headRefName: "track/old", body: "", createdAt: daysAgo(150) },
    ]);
    const refused = mshapeWith(env, repo, "rm", "old", "--keep-beads");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("its branch's reflog no longer reaches its creation");
    expect(refused.stderr).not.toContain("no PR from `track/old` has merged");
  });

  test("a branch made before track new recorded its start falls back to its reflog", async () => {
    await setup();
    mshape(repo, "new", "old");
    sh(repo, "config", "--unset", "branch.track/old.mshape-started");
    const env = await fakeBd([]);
    const merged = (createdAt: string) => [
      { number: 1, state: "MERGED", headRefName: "track/old", body: "", createdAt },
    ];
    // A PR opened before the branch existed is someone else's; one opened since is its own.
    await fakeGh(merged("2020-01-01T00:00:00Z"));
    expect(mshapeWith(env, repo, "list").stdout).toMatch(/^old\s+\S+\s+0\s+0\s+yes\s+no\s/m);
    await fakeGh(merged(new Date(Date.now() + 60_000).toISOString()));
    expect(mshapeWith(env, repo, "list").stdout).toMatch(/^old\s+\S+\s+0\s+0\s+yes\s+yes\s/m);
  });

  test("list derives done from beads, merge and PRs; flags beads open after their PR merged", async () => {
    await setup();
    for (const track of ["docs", "init", "wip"]) mshape(repo, "new", track);
    await writeFile(`${wt("wip")}/page.md`, "page\n");
    sh(wt("wip"), "add", ".");
    sh(wt("wip"), "commit", "-qm", "page");
    const env = await fakeBd([
      bead("x-1", "open", ["track:init"]),
      bead("x-2", "in_progress", []),
      bead("x-3", "closed", ["track:docs"]),
    ]);
    // Opened now: after each track started.
    const pr = (number: number, state: string, head: string, beads: string) => ({
      number,
      state,
      headRefName: head,
      body: `## Beads\n\n${beads}\n`,
      createdAt: new Date().toISOString(),
    });
    await fakeGh([
      pr(1, "MERGED", "track/docs", "- x-3 done\n- x-2 left open"),
      pr(2, "OPEN", "track/docs", "- x-3"),
      pr(3, "MERGED", "track/init", "- x-1"),
      pr(4, "MERGED", "other-branch", "- x-2"),
    ]);
    const cells = (text: string, track: string) =>
      text
        .split("\n")
        .find((line) => line.startsWith(`${track} `))
        ?.split(/\s+/);

    const listed = mshapeWith(env, repo, "list").stdout;
    // docs: merged and no beads, but PR #2 is open. init: an open bead. wip: unmerged.
    expect(cells(listed, "docs")?.[5]).toBe("no");
    expect(cells(listed, "init")?.[5]).toBe("no");
    expect(cells(listed, "wip")?.[5]).toBe("no");
    expect(listed).toContain(
      "  docs: x-2 (in_progress) is listed in merged PR #1 but still open: close it if its work is done (`bd close x-2`), or write what is left in its notes and defer it (`bd defer x-2`)",
    );
    expect(listed).toContain("  init: x-1 (open) is listed in merged PR #3 but still open");
    // PR #4 isn't a track's: its bead is nobody's here.
    expect(listed.match(/merged PR #4/g)).toBeNull();
    // wip's handoff State is from today, as is its commit: no hygiene warning.
    expect(listed).not.toContain("wip: its handoff's State");

    // PR #2 merges: docs is done, and says how to remove it.
    await fakeGh([
      pr(1, "MERGED", "track/docs", "- x-3 done"),
      pr(2, "MERGED", "track/docs", "- x-3"),
    ]);
    const done = mshapeWith(env, repo, "list").stdout;
    expect(cells(done, "docs")?.[5]).toBe("yes");
    expect(done).toContain("  docs: done: remove it with `mshape track rm docs`");

    // gh can't answer: unknown, with a note, never yes.
    await fakeGh(undefined);
    const blind = mshapeWith(env, repo, "list").stdout;
    expect(cells(blind, "docs")?.[5]).toBe("unknown");
    expect(cells(blind, "wip")?.[5]).toBe("no");
    expect(blind).toContain(
      "note: PRs not read, so done is unknown where they decide it: `gh pr list` failed: no git remotes found",
    );
  });

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
    expect(listed).toMatch(/^init\s+none\s+1\s+-\s+-\s+no\s+-$/m);

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

  test("bd not installed: rm refuses whether beads is optional or required; list notes it", async () => {
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

    // Optional too: check would only note it, but rm can't be undone, so it refuses.
    await writeFile(join(repo, "shape.config.ts"), "export default {};\n");
    const optional = mshapeWith(noBd, repo, "rm", "docs");
    expect(optional.code).toBe(1);
    expect(optional.stderr).toContain(
      "this repo has beads (.beads/), but bd is not on PATH, so the beads labelled `track:docs` can't be seen",
    );
    expect(await exists(wt("docs"))).toBe(true);
    expect(mshapeWith(noBd, repo, "list").stdout).toContain("note: open beads not counted");
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

  test.skipIf(Bun.which("bd") === null)(
    "with the real bd: a reused name's next beads don't strand the old track; --keep-beads hands them on (4q6)",
    async () => {
      // The milestone boundary: the old track merged and clean, its bead closed, and the next
      // milestone's bead already filed with the same label, as /milestone grooms before rm.
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
      bd("close", bd("create", "--title", "old work", "--labels", "track:docs", "--silent"));
      await writeFile(`${wt("docs")}/page.md`, "page\n");
      sh(wt("docs"), "add", ".");
      sh(wt("docs"), "commit", "-qm", "page");
      sh(repo, "merge", "-q", "--no-edit", "track/docs");
      const next = bd("create", "--title", "next work", "--labels", "track:docs", "--silent");
      const pr = (state: string) => ({
        number: 7,
        state,
        headRefName: "track/docs",
        body: "",
        createdAt: new Date().toISOString(),
      });

      // Its PR is still open: not done, so its beads aren't handed on (6p7).
      await fakeGh([pr("OPEN")]);
      const unfinished = mshape(repo, "rm", "docs", "--keep-beads");
      expect(unfinished.code).toBe(1);
      expect(unfinished.stderr).toContain(
        "--keep-beads hands the beads to a new track of this name only once this one is done, and that isn't shown: PR #7 from `track/docs` is still open",
      );
      await fakeGh([pr("MERGED")]);

      const refused = mshape(repo, "rm", "docs");
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain("pass --keep-beads to leave them labelled for it");
      expect(await exists(wt("docs"))).toBe(true);

      const removed = mshape(repo, "rm", "docs", "--keep-beads");
      expect(removed.code).toBe(0);
      expect(removed.stdout).toContain(
        "kept 1 open bead(s) labelled `track:docs`, for the next track of that name (--keep-beads): start it with `mshape track new docs`",
      );
      expect(await exists(wt("docs"))).toBe(false);
      expect(bd("show", next, "--json")).toContain("track:docs");

      // The next track of the name starts fresh, with the bead in its queue.
      expect(mshape(repo, "new", "docs").code).toBe(0);
      expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+1\s+0\s+yes\s+no\s/m);
    },
    30_000,
  );
});

/**
 * A PR merged on the remote, as GitHub does it, while the main checkout's `main` is behind:
 * `origin` is a bare repo, and a second clone stands in for the merge button.
 */
describe("merged upstream, before anyone pulls main", () => {
  /** The track's two commits reach origin's main by `style`, after main has moved on there. */
  const merged = async (style: "merge" | "squash" | "rebase" | "squash-nearby" = "merge") => {
    await setup();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    await writeFile(`${repo}/lines.txt`, `${lines.join("\n")}\n`);
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "lines");
    const origin = `${base}/origin.git`;
    sh(base, "init", "-q", "--bare", "-b", "main", origin);
    sh(repo, "remote", "add", "origin", origin);
    sh(repo, "push", "-q", "-u", "origin", "main");
    mshape(repo, "new", "docs");
    for (const page of ["one", "two"]) {
      await writeFile(`${wt("docs")}/${page}.md`, page);
      sh(wt("docs"), "add", ".");
      sh(wt("docs"), "commit", "-qm", page);
    }
    if (style === "squash-nearby") {
      const edited = lines.map((line, i) => (i === 9 ? "line 10, by the track" : line));
      await writeFile(`${wt("docs")}/lines.txt`, `${edited.join("\n")}\n`);
      sh(wt("docs"), "commit", "-qam", "line 10");
    }
    sh(wt("docs"), "push", "-q", "origin", "track/docs");

    const github = `${base}/github`;
    sh(base, "clone", "-q", origin, github);
    sh(github, "config", "user.name", "Test");
    sh(github, "config", "user.email", "test@example.com");
    await writeFile(`${github}/other.md`, "meanwhile");
    // Two lines from the track's change: inside the three lines of context a patch carries.
    if (style === "squash-nearby")
      await writeFile(
        `${github}/lines.txt`,
        `${lines.map((line, i) => (i === 11 ? "line 12, by main" : line)).join("\n")}\n`,
      );
    sh(github, "add", ".");
    sh(github, "commit", "-qm", "main moves on");
    if (style === "merge") sh(github, "merge", "-q", "--no-ff", "--no-edit", "origin/track/docs");
    if (style === "squash" || style === "squash-nearby") {
      sh(github, "merge", "-q", "--squash", "origin/track/docs");
      sh(github, "commit", "-qm", "docs (#1)");
    }
    if (style === "rebase") {
      sh(github, "switch", "-qc", "rebased", "origin/track/docs");
      sh(github, "rebase", "-q", "main");
      sh(github, "switch", "-q", "main");
      sh(github, "merge", "-q", "--ff-only", "rebased");
    }
    sh(github, "push", "-q", "origin", "main");
    return origin;
  };

  test("rm fetches main's upstream, sees the merge and removes the track; local main is untouched", async () => {
    await merged();
    const mainBefore = sh(repo, "rev-parse", "main");
    const removed = mshape(repo, "rm", "docs");
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain("removed branch `track/docs`");
    expect(await exists(wt("docs"))).toBe(false);
    expect(sh(repo, "rev-parse", "main")).toBe(mainBefore);
  });

  test("list counts a branch merged into origin/main as merged, once that ref is fetched", async () => {
    await merged();
    expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+-\s+2\s+no/m);
    sh(repo, "fetch", "-q", "origin");
    expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+-\s+0\s+yes/m);
  });

  test("a remote it can't reach is a note, and rm judges on the refs it has", async () => {
    const origin = await merged();
    await rename(origin, `${base}/gone.git`);
    const refused = mshape(repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("note: couldn't fetch `main` from `origin`");
    expect(refused.stderr).toContain("2 commit(s) not in `main` or `origin/main`");
    expect(await exists(wt("docs"))).toBe(true);
  });

  test.each(["squash", "rebase"] as const)(
    "a %s merge counts as merged: rm removes the track, list says so",
    async (style) => {
      await merged(style);
      sh(repo, "fetch", "-q", "origin");
      // The original commits are in neither main, yet the work is.
      expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+-\s+2\s+yes/m);
      expect(mshape(repo, "rm", "docs").code).toBe(0);
      expect(branches()).toEqual(["main"]);
    },
  );

  test("work that differs from what was squashed stays unmerged", async () => {
    await merged("squash");
    await writeFile(`${wt("docs")}/three.md`, "after the merge");
    sh(wt("docs"), "add", ".");
    sh(wt("docs"), "commit", "-qm", "three");
    const refused = mshape(repo, "rm", "docs");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("isn't there by a merge, a rebase or a squash either");
    expect(branches()).toEqual(["main", "track/docs"]);
  });

  test("the fetch uses the user's own core.sshCommand", async () => {
    await setup();
    mshape(repo, "new", "docs");
    sh(repo, "remote", "add", "origin", "ssh://git.invalid/repo.git");
    sh(repo, "config", "branch.main.remote", "origin");
    sh(repo, "config", "branch.main.merge", "refs/heads/main");
    // Their SSH command, as a deploy key or a second account would set it: here it logs and fails.
    await writeFile(`${base}/ssh`, `#!/bin/sh\necho called >> "${base}/ssh.log"\nexit 1\n`);
    await chmod(`${base}/ssh`, 0o755);
    sh(repo, "config", "core.sshCommand", `${base}/ssh`);

    const result = mshape(repo, "rm", "docs");
    expect(result.stderr).toContain("note: couldn't fetch `main` from `origin`");
    expect(await exists(`${base}/ssh.log`)).toBe(true);
  });

  test("a squash after main edited a nearby line counts as merged; older git's patch ids refuse it", async () => {
    await merged("squash-nearby");
    sh(repo, "fetch", "-q", "origin");
    expect(mshape(repo, "list").stdout).toMatch(/^docs\s+stub\s+-\s+3\s+yes/m);
    // Without merge-tree (git before 2.38), patches with context don't match: rm asks for --force.
    expect(
      await Effect.runPromise(patchMerged(repo, "track/docs", "refs/remotes/origin/main")),
    ).toBe(false);
    expect(mshape(repo, "rm", "docs").code).toBe(0);
  });

  test("one copy of a repeated line fixed on each side: unmerged, and rm refuses", async () => {
    await setup();
    // The same line twice, far apart: without context, the two fixes would look like one patch.
    const code = [
      "  retrun x;",
      ...Array.from({ length: 30 }, (_, i) => `  step(${i});`),
      "  retrun x;",
    ];
    await writeFile(`${repo}/code.txt`, `${code.join("\n")}\n`);
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "code");
    mshape(repo, "new", "dup");
    const fixed = (index: number) =>
      `${code.map((line, i) => (i === index ? "  return x;" : line)).join("\n")}\n`;
    await writeFile(`${wt("dup")}/code.txt`, fixed(0));
    sh(wt("dup"), "commit", "-qam", "fix the first");
    await writeFile(`${repo}/code.txt`, fixed(code.length - 1));
    sh(repo, "commit", "-qam", "fix the last");

    expect(mshape(repo, "list").stdout).toMatch(/^dup\s+stub\s+-\s+1\s+no/m);
    expect(await Effect.runPromise(patchMerged(repo, "track/dup", "refs/heads/main"))).toBe(false);
    expect(mshape(repo, "rm", "dup").code).toBe(1);
    expect(branches()).toEqual(["main", "track/dup"]);
  });
});
