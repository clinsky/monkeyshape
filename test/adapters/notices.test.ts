/**
 * Live notices through the CLI against real git worktrees, a fake Claude Code config
 * directory (CLAUDE_CONFIG_DIR) and real Unix sockets standing in for sessions, so the
 * Claude Code notifier itself is exercised. The CLI runs with async spawn: the test's own
 * socket servers have to keep accepting while it runs.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let base = "";
let repo = "";
let claude = "";
let servers: Array<Server> = [];

const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

const mshape = async (cwd: string, args: ReadonlyArray<string>, stdin = "") => {
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: claude, CLAUDE_CODE_SESSION_ID: "" },
    stdin: new Blob([stdin]),
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

const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
const registry = (track: string) => `${repo}/.git/monkeyshape/sessions/${track}`;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A Claude Code session: its record, its key, and (when `listen`) a socket collecting lines. */
const claudeSession = async (n: number, options: { listen?: boolean; protocol?: number } = {}) => {
  const socket = `${base}/s${n}.sock`;
  const received: Array<string> = [];
  if (options.listen ?? true) {
    const server = createServer((connection) => {
      let text = "";
      connection.on("data", (data) => {
        text += data.toString();
      });
      connection.on("end", () => received.push(text));
    });
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    servers.push(server);
  }
  await writeFile(
    `${claude}/sessions/${1000 + n}.json`,
    JSON.stringify({
      pid: 1000 + n,
      sessionId: uuid(n),
      procStart: `p${n}`,
      peerProtocol: options.protocol ?? 1,
      messagingSocketPath: socket,
      status: "idle",
    }),
  );
  await writeFile(
    `${claude}/sessions/${1000 + n}.abc.key`,
    JSON.stringify({ peerToken: `token-${n}`, procStart: `p${n}`, pidDomain: "x" }),
  );
  return received;
};

const hookInput = (n: number) =>
  JSON.stringify({ session_id: uuid(n), hook_event_name: "SessionStart", source: "startup" });

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-notices-")));
  repo = join(base, "repo");
  claude = join(base, "claude");
  await mkdir(`${claude}/sessions`, { recursive: true });
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "shape.config.ts"), "export default {};\n");
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.agents/handoffs\n.handoffs\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  for (const track of ["docs", "tracks"])
    expect((await mshape(repo, ["track", "new", track])).code).toBe(0);
});

afterEach(async () => {
  for (const server of servers) server.close();
  servers = [];
  await rm(base, { recursive: true, force: true });
});

describe("live notices", () => {
  test("every live session of the track gets the subject line with its own token, never the body", async () => {
    const first = await claudeSession(1);
    const second = await claudeSession(2);
    const other = await claudeSession(3);
    for (const n of [1, 2]) {
      const registered = await mshape(wt("tracks"), ["msg", "register"], hookInput(n));
      expect(registered).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    // A session of another track is registered there, and never told about this track's mail.
    expect((await mshape(wt("docs"), ["msg", "register"], hookInput(3))).code).toBe(0);

    const sent = await mshape(wt("docs"), [
      "msg",
      "send",
      "tracks",
      "--subject",
      "parser changed",
      "the body",
    ]);
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain("Notified 2 live sessions of tracks.");
    const id = /Sent (\S+)/.exec(sent.stdout)?.[1] ?? "";
    for (const [received, token] of [
      [first, "token-1"],
      [second, "token-2"],
    ] as const) {
      expect(received).toHaveLength(1);
      const [auth, user] = (received[0] ?? "")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(auth).toEqual({ type: "auth", token });
      expect(user.message.content).toBe(
        `[mshape] Message from docs: parser changed (bun run --silent mshape msg read ${id})`,
      );
    }
    expect(other).toEqual([]);
    // The notice marked nothing read.
    expect((await mshape(wt("tracks"), ["msg", "inbox"])).stdout).toContain(id);
  });

  test("an ended session, a cleared one and a dead socket are pruned; the mail still waits", async () => {
    await claudeSession(1, { listen: false });
    await claudeSession(2);
    await claudeSession(4);
    for (const n of [1, 2, 4]) await mshape(wt("tracks"), ["msg", "register"], hookInput(n));
    await rm(`${claude}/sessions/1002.json`);
    await writeFile(
      `${claude}/sessions/1004.json`,
      JSON.stringify({
        pid: 1004,
        sessionId: uuid(5),
        procStart: "p4",
        peerProtocol: 1,
        messagingSocketPath: `${base}/s4.sock`,
      }),
    );
    const sent = await mshape(wt("docs"), ["msg", "send", "tracks", "--subject", "s"]);
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain("No live session of tracks to notify");
    expect(sent.stdout).toContain("its socket refused the notice (ENOENT)");
    expect(sent.stdout).toContain("its Claude Code session has ended");
    expect(sent.stdout).toContain("its process now runs another session");
    expect(await readdir(registry("tracks"))).toEqual([]);
    expect((await mshape(wt("tracks"), ["msg", "inbox", "--quiet"])).stdout).toContain(": s");
  });

  test("a session on another protocol is skipped with a note and kept", async () => {
    const received = await claudeSession(1, { protocol: 2 });
    await mshape(wt("tracks"), ["msg", "register"], hookInput(1));
    const sent = await mshape(wt("docs"), ["msg", "send", "tracks", "--subject", "s"]);
    expect(sent.stdout).toContain("speaks messaging protocol 2; this mshape knows 1");
    expect(received).toEqual([]);
    expect(await readdir(registry("tracks"))).toEqual([`${uuid(1)}.json`]);
  });

  test("register: silent outside a track; a note, never a failure, when it can't", async () => {
    await claudeSession(1);
    expect(await mshape(repo, ["msg", "register"], hookInput(1))).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    const unknown = await mshape(wt("tracks"), ["msg", "register"], hookInput(9));
    expect(unknown.code).toBe(0);
    expect(unknown.stdout).toContain(`Claude Code has no record of session ${uuid(9)}`);
    const bad = await mshape(wt("tracks"), ["msg", "register"], '{"session_id":"../x"}');
    expect(bad.code).toBe(0);
    expect(bad.stdout).toContain("is not a Claude Code session id");
    expect(await readdir(registry("tracks")).catch(() => [])).toEqual([]);
  });
});
