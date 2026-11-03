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
    env: { ...process.env, CLAUDE_CONFIG_DIR: join(base, "no-claude"), ...env },
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
