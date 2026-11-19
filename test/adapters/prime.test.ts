/**
 * `mshape prime` through the CLI, against a real repo with tracks, a fake `bd` and a fake
 * Claude Code config directory: the plan's `mshape prime` table, a test per row, and the rows
 * of its Session registry table that need the registry on disk.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let base = "";
let repo = "";
let claude = "";
/** A directory holding a fake `bd`, which prints the repo's PRIME as `bd prime` does. */
let bdDir = "";

const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
const registry = (address: string) => `${repo}/.git/monkeyshape/sessions/${address}`;
const registered = (address: string) => readdir(registry(address)).catch(() => []);
const hookInput = (n: number, source = "startup") =>
  JSON.stringify({ session_id: uuid(n), hook_event_name: "SessionStart", source });

/** PATH with git and bun, and the fake bd unless `bd` is false. */
const path = (bd: boolean) =>
  [...(bd ? [bdDir] : []), dirname(process.execPath), "/usr/bin", "/bin"].join(":");

const mshape = async (
  cwd: string,
  args: ReadonlyArray<string>,
  options: { stdin?: string; env?: Record<string, string>; bd?: boolean } = {},
) => {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: {
      HOME: base,
      PATH: path(options.bd ?? true),
      CLAUDE_CONFIG_DIR: claude,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
      ...options.env,
    },
    stdin: new Blob([options.stdin ?? ""]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const PRIME = "# The working loop (this repo's PRIME)";

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-prime-")));
  repo = join(base, "repo");
  claude = join(base, "claude");
  bdDir = join(base, "bd-bin");
  await mkdir(`${claude}/sessions`, { recursive: true });
  await mkdir(bdDir);
  await writeFile(
    join(bdDir, "bd"),
    '#!/bin/sh\n[ "$1" = prime ] && [ -f .beads/PRIME.md ] && cat .beads/PRIME.md && echo "(bd memories)" && exit 0\nexit 1\n',
  );
  await chmod(join(bdDir, "bd"), 0o755);
  await mkdir(join(repo, ".beads"), { recursive: true });
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "shape.toml"), 'packs = ["typescript"]\n');
  await writeFile(join(repo, ".beads", "PRIME.md"), `${PRIME}\n`);
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.agents/handoffs\n.handoffs\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  for (const track of ["docs", "tracks"])
    expect((await mshape(repo, ["track", "new", track])).code).toBe(0);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("mshape prime: the plan's table", () => {
  test("a session start, hooked, at a track's worktree: PRIME, registered at the track, unread subjects", async () => {
    await mshape(repo, ["msg", "send", "docs", "--subject", "read me", "body"]);
    const primed = await mshape(wt("docs"), ["--harness", "claude-code", "prime"], {
      stdin: hookInput(1),
    });
    expect(primed.code).toBe(0);
    expect(primed.stdout).toStartWith(`${PRIME}\n(bd memories)`);
    expect(primed.stdout).toContain("read me");
    expect(primed.stdout).not.toContain("body");
    expect(primed.stdout).not.toContain("note:");
    expect(await registered("docs")).toEqual([`claude-code.${uuid(1)}.json`]);
  });

  test("run by the agent with no hook: the same, identified from the environment", async () => {
    const primed = await mshape(wt("docs"), ["prime"], {
      env: { CLAUDE_CODE_SESSION_ID: uuid(2), CLAUDE_PID: "4242" },
    });
    expect(primed.code).toBe(0);
    expect(primed.stdout).toStartWith(PRIME);
    expect(await registered("docs")).toEqual([`claude-code.${uuid(2)}.json`]);
    const record = await Bun.file(`${registry("docs")}/claude-code.${uuid(2)}.json`).json();
    expect(record).toMatchObject({ harness: "claude-code", session: uuid(2), pid: 4242 });
  });

  test("run with nothing to identify it: registration skipped with one note naming what was missing", async () => {
    const primed = await mshape(wt("docs"), ["prime"]);
    expect(primed.code).toBe(0);
    expect(primed.stdout).toStartWith(PRIME);
    const notes = primed.stdout.split("\n").filter((line) => line.startsWith("note:"));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("no session identity: nothing identified the session");
    expect(notes[0]).toContain("CLAUDE_CODE_SESSION_ID");
    expect(await registered("docs")).toEqual([]);
  });

  test("bd missing: PRIME's text still prints, from .beads/PRIME.md, with a note; exits 0", async () => {
    const primed = await mshape(wt("docs"), ["prime"], { stdin: hookInput(1), bd: false });
    expect(primed.code).toBe(0);
    expect(primed.stdout).toStartWith(PRIME);
    expect(primed.stdout).not.toContain("(bd memories)");
    expect(primed.stdout).toContain("note: bd could not run here (not installed)");
    expect(await registered("docs")).toEqual([`claude-code.${uuid(1)}.json`]);
  });

  test("outside every address (a scratch dir): PRIME only; no registration, no note about mail", async () => {
    const scratch = join(base, "scratch");
    await mkdir(join(scratch, ".beads"), { recursive: true });
    await writeFile(join(scratch, ".beads", "PRIME.md"), `${PRIME}\n`);
    const primed = await mshape(scratch, ["prime"], { stdin: hookInput(1) });
    expect(primed).toEqual({ code: 0, stdout: `${PRIME}\n(bd memories)`, stderr: "" });
  });

  test("run twice in one session (compact, clear, resume): one registration", async () => {
    for (const source of ["startup", "compact"]) {
      const primed = await mshape(wt("docs"), ["--harness", "claude-code", "prime"], {
        stdin: hookInput(1, source),
      });
      expect(primed.stdout).not.toContain("note:");
    }
    expect(await registered("docs")).toEqual([`claude-code.${uuid(1)}.json`]);
  });

  test("stdin is a terminal: never waits on it", () => {
    // `script` gives the command a terminal of its own; `timeout` fails the test on a wait.
    const command = `PATH=${path(true)} HOME=${base} CLAUDE_CONFIG_DIR=${claude} CLAUDE_CODE_SESSION_ID= CLAUDE_PID= timeout 10 ${process.execPath} ${CLI} prime; echo "exit $?"`;
    const ran = Bun.spawnSync(["script", "-qec", command, "/dev/null"], {
      cwd: wt("docs"),
      stdout: "pipe",
    });
    expect(ran.stdout.toString()).toContain(PRIME);
    expect(ran.stdout.toString()).toContain("exit 0");
  });

  test("stdin is a pipe nobody closes: gives up on it within seconds", async () => {
    const started = Date.now();
    const child = Bun.spawn([process.execPath, CLI, "prime"], {
      cwd: wt("docs"),
      env: { HOME: base, PATH: path(true), CLAUDE_CONFIG_DIR: claude },
      stdin: "pipe",
      stdout: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(stdout).toContain(PRIME);
    child.stdin.end();
  });

  test("a repo whose shape.toml doesn't load: PRIME and mail still print", async () => {
    await mshape(repo, ["msg", "send", "docs", "--subject", "still here", "body"]);
    await writeFile(join(wt("docs"), "shape.toml"), "packs = [\n");
    const primed = await mshape(wt("docs"), ["--harness", "claude-code", "prime"], {
      stdin: hookInput(1),
    });
    expect(primed.code).toBe(0);
    expect(primed.stdout).toStartWith(PRIME);
    expect(primed.stdout).toContain("still here");
  });
});

describe("mshape --harness", () => {
  test("names one this mshape ships, or is refused naming them", async () => {
    const bad = await mshape(wt("docs"), ["--harness", "cursor", "prime"]);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("--harness takes one of claude-code, codex, pi, not `cursor`");
  });

  test("a harness shipped but not built yet identifies nobody, and asks no other", async () => {
    const primed = await mshape(wt("docs"), ["--harness", "codex", "prime"], {
      stdin: hookInput(1),
      env: { CLAUDE_CODE_SESSION_ID: uuid(1) },
    });
    expect(primed.code).toBe(0);
    expect(primed.stdout).toContain("no session identity: no harness this mshape ships is codex");
    expect(await registered("docs")).toEqual([]);
  });
});

describe("Session registry: the plan's rows on disk", () => {
  test("a 0.6.0 registration is read as claude-code, and refiled under its harness at the next start", async () => {
    await mkdir(registry("docs"), { recursive: true });
    await writeFile(
      `${registry("docs")}/${uuid(1)}.json`,
      JSON.stringify({ session: uuid(1), pid: 7, registered: "2026-01-01T00:00:00.000Z" }),
    );
    const inbox = await mshape(wt("tracks"), ["msg", "inbox", "--quiet"], {
      env: { CLAUDE_CODE_SESSION_ID: uuid(1) },
    });
    // Still its own address: the 0.6.0 file is the session's registration.
    expect(inbox.stdout).not.toContain("isn't registered");
    await mshape(wt("docs"), ["--harness", "claude-code", "prime"], { stdin: hookInput(1) });
    expect(await registered("docs")).toEqual([`claude-code.${uuid(1)}.json`]);
  });

  test("a registration whose harness this mshape doesn't ship: skipped with a note naming it, never pruned", async () => {
    await mkdir(registry("docs"), { recursive: true });
    const foreign = JSON.stringify({
      harness: "cursor",
      session: "c1",
      registered: "2026-01-01T00:00:00.000Z",
    });
    await writeFile(`${registry("docs")}/cursor.c1.json`, foreign);
    const sent = await mshape(repo, ["msg", "send", "docs", "--subject", "s", "b"]);
    expect(sent.stdout).toContain(
      "session c1: its harness, cursor, isn't one this mshape ships; kept",
    );
    expect(await registered("docs")).toEqual(["cursor.c1.json"]);
  });

  test("a session resumed with a new process: the registration is updated, not duplicated", async () => {
    await mshape(wt("docs"), ["--harness", "claude-code", "prime"], {
      stdin: hookInput(1),
      env: { CLAUDE_PID: "100" },
    });
    await mshape(wt("docs"), ["--harness", "claude-code", "prime"], {
      stdin: hookInput(1, "resume"),
      env: { CLAUDE_PID: "200" },
    });
    expect(await registered("docs")).toEqual([`claude-code.${uuid(1)}.json`]);
    const record = await Bun.file(`${registry("docs")}/claude-code.${uuid(1)}.json`).json();
    expect(record.pid).toBe(200);
  });
});
