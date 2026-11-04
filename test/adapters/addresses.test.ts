/**
 * Session addresses: the plan's case table, one test per row, through the CLI against real
 * git (a bare `origin` publishing pull requests as GitHub does), a fake Claude Code config
 * directory and real Unix sockets standing in for sessions. A session's address is the
 * checkout it serves: a track, `main`, or `review-<n>`. Mail and notices follow the address;
 * `track rm` still counts every session in the worktree, registered or not.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { liveSessions } from "../../src/adapters/notices.ts";

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

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/**
 * Who runs the command, as Claude Code's environment says: session `n` in process `1000 + n`,
 * a session id or a pid alone, or nobody (a terminal).
 */
type Who = number | { readonly session?: number; readonly pid?: number } | undefined;

const mshape = async (cwd: string, args: ReadonlyArray<string>, who: Who, stdin = "") => {
  const { session, pid } =
    typeof who === "number" ? { session: who, pid: 1000 + who } : (who ?? {});
  const identity = {
    CLAUDE_CODE_SESSION_ID: session === undefined ? "" : uuid(session),
    CLAUDE_PID: pid === undefined ? "" : String(pid),
  };
  const child = Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    // Pinned: these tests may run inside a Claude Code session, whose own ids must not leak in.
    env: { ...process.env, CLAUDE_CONFIG_DIR: claude, ...identity },
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

/** What a hook gets: the session's id on stdin, and its process's pid in the environment. */
const hook = (
  cwd: string,
  args: ReadonlyArray<string>,
  n: number,
  source = "startup",
  pid = 1000 + n,
) =>
  mshape(
    cwd,
    args,
    { pid },
    JSON.stringify({ session_id: uuid(n), hook_event_name: "SessionStart", source }),
  );

/** The SessionStart hook, as session `n` starting in `cwd`. */
const start = (cwd: string, n: number) => hook(cwd, ["msg", "register"], n);

/** The UserPromptSubmit hook's inbox, as session `n`. */
const prompt = (cwd: string, n: number) => hook(cwd, ["msg", "inbox", "--quiet"], n);

const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
const reviewWt = (pr: number) => `${repo}/.agents/worktrees/repo.pr-${pr}`;
const registry = (address: string) => `${repo}/.git/monkeyshape/sessions/${address}`;
const registered = (address: string) =>
  readdir(registry(address)).then(
    (files) => files.filter((file) => !file.startsWith(".")).sort(),
    () => [],
  );
const at = (...sessions: ReadonlyArray<number>) => sessions.map((n) => `${uuid(n)}.json`);

/** A Claude Code session: its record, its key, and a socket collecting what it is told. */
const claudeSession = async (n: number, cwd = repo) => {
  const socket = `${base}/s${n}.sock`;
  const received: Array<string> = [];
  const server = createServer((connection) => {
    let text = "";
    connection.on("data", (data) => {
      text += data.toString();
    });
    connection.on("end", () => received.push(text));
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  servers.push(server);
  await writeFile(
    `${claude}/sessions/${1000 + n}.json`,
    JSON.stringify({
      pid: 1000 + n,
      cwd,
      sessionId: uuid(n),
      procStart: `p${n}`,
      peerProtocol: 1,
      messagingSocketPath: socket,
    }),
  );
  await writeFile(
    `${claude}/sessions/${1000 + n}.abc.key`,
    JSON.stringify({ peerToken: `token-${n}`, procStart: `p${n}` }),
  );
  return received;
};

/** Backdates every registration at `address`, as if each session had registered long ago. */
const age = async (address: string) => {
  for (const file of await registered(address)) {
    const path = `${registry(address)}/${file}`;
    const registration = await Bun.file(path).json();
    await writeFile(
      path,
      JSON.stringify({ ...registration, registered: "2026-01-01T00:00:00.000Z" }),
    );
  }
};

let pushes = 0;

/** The author publishes pull request `pr`, as GitHub would: a new head each time. */
const publish = (pr: number) => {
  const author = join(base, "author");
  sh(author, "fetch", "-q", "origin", "main");
  sh(author, "switch", "-q", "--detach", "origin/main");
  sh(author, "commit", "-q", "--allow-empty", "-m", `pr ${pr}, push ${++pushes}`);
  sh(author, "push", "-q", "-f", "origin", `HEAD:refs/pull/${pr}/head`);
};

const send = (from: string, to: string, subject: string) =>
  mshape(from, ["msg", "send", to, "--subject", subject], undefined);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-addresses-")));
  claude = join(base, "claude");
  await mkdir(`${claude}/sessions`, { recursive: true });
  sh(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ] as const)
    sh(repo, "config", key, value);
  sh(repo, "remote", "add", "origin", join(base, "origin.git"));
  await writeFile(join(repo, "shape.config.ts"), "export default {};\n");
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.agents/handoffs\n.handoffs\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  sh(repo, "push", "-q", "origin", "main");
  sh(base, "clone", "-q", join(base, "origin.git"), "author");
  for (const [key, value] of [
    ["user.name", "Author"],
    ["user.email", "a@example.com"],
    ["commit.gpgsign", "false"],
  ] as const)
    sh(join(base, "author"), "config", key, value);
  for (const pr of [12, 13]) publish(pr);
  for (const track of ["docs", "tracks"])
    expect((await mshape(repo, ["track", "new", track], undefined)).code).toBe(0);
});

afterEach(async () => {
  for (const server of servers) server.close();
  servers = [];
  await rm(base, { recursive: true, force: true });
});

describe("session addresses: the plan's case table", () => {
  test("a session starts in a track's worktree: registered at <track>", async () => {
    await claudeSession(1, wt("docs"));
    expect(await start(wt("docs"), 1)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await registered("docs")).toEqual(at(1));
  });

  test("a session starts in the main checkout: registered at main", async () => {
    await claudeSession(1);
    expect(await start(repo, 1)).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(await registered("main")).toEqual(at(1));
    // And `main` receives: a track's message reaches it live, and its inbox lists it.
    const received = await claudeSession(2);
    await start(repo, 2);
    const sent = await send(wt("docs"), "main", "a question for the boundary");
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain("Notified 2 live sessions of main.");
    expect(received).toHaveLength(1);
    expect((await prompt(repo, 1)).stdout).toContain("from docs");
    const id = /Sent (\S+)/.exec(sent.stdout)?.[1] ?? "";
    const read = await mshape(repo, ["msg", "read", id], 1);
    expect(read.stdout).toContain("To: main");
    expect((await prompt(repo, 2)).stdout).toBe("");
  });

  test("a session at main runs `mshape review <n>`: moves to review-<n>; any other session at main is untouched", async () => {
    const reviewer = await claudeSession(1);
    const other = await claudeSession(2);
    for (const n of [1, 2]) await start(repo, n);
    const reviewed = await mshape(repo, ["review", "12"], 1);
    expect(reviewed.code).toBe(0);
    expect(`${reviewed.stdout}\n${reviewed.stderr}`).toContain(
      `session ${uuid(1)}: main -> review-12`,
    );
    expect(await registered("main")).toEqual(at(2));
    expect(await registered("review-12")).toEqual(at(1));

    // The maintainer's run: the reviewer gets none of main's or the track's mail.
    const toMain = await send(wt("docs"), "main", "for the planner");
    expect(toMain.stdout).toContain("Notified 1 live session of main.");
    expect(other).toHaveLength(1);
    expect(reviewer).toEqual([]);
    expect((await prompt(repo, 1)).stdout).toBe("");
    expect((await prompt(repo, 2)).stdout).toContain("for the planner");
    // Mail to the review reaches it, and its replies come from the review.
    const toReview = await send(wt("docs"), "review-12", "fixed in abc");
    expect(toReview.stdout).toContain("Notified 1 live session of review-12.");
    expect((await prompt(repo, 1)).stdout).toContain("fixed in abc");
    const reply = await mshape(repo, ["msg", "send", "docs", "--subject", "thanks"], 1);
    expect(reply.stdout).toContain("Sent");
    const inbox = await mshape(wt("docs"), ["msg", "inbox"], undefined);
    expect(inbox.stdout).toContain("from review-12");
  });

  test("a session at a track runs `mshape review <n>`: stays at its track; the review worktree is made or refreshed, no address moves", async () => {
    await claudeSession(1, wt("docs"));
    await start(wt("docs"), 1);
    for (const _ of [1, 2]) {
      const reviewed = await mshape(wt("docs"), ["review", "12"], 1);
      expect(reviewed.code).toBe(0);
      expect(reviewed.stdout).toContain(reviewWt(12));
      expect(`${reviewed.stdout}\n${reviewed.stderr}`).not.toContain(`session ${uuid(1)}:`);
    }
    expect(await registered("docs")).toEqual(at(1));
    expect(await registered("review-12")).toEqual([]);
  });

  test("a session at review-<n> runs `mshape review <n>` again: stays at review-<n>", async () => {
    await claudeSession(1);
    await start(repo, 1);
    await mshape(repo, ["review", "12"], 1);
    publish(12);
    const again = await mshape(repo, ["review", "12"], 1);
    expect(again.code).toBe(0);
    expect(again.stdout).toContain("previous head");
    expect(await registered("review-12")).toEqual(at(1));
    expect(await registered("main")).toEqual([]);
  });

  test("a session at review-<n> runs `mshape review <m>`: moves to review-<m>; review-<n>'s unread mail stays there", async () => {
    await claudeSession(1);
    await start(repo, 1);
    await mshape(repo, ["review", "12"], 1);
    await send(wt("docs"), "review-12", "unread at twelve");
    const moved = await mshape(repo, ["review", "13"], 1);
    expect(moved.code).toBe(0);
    expect(`${moved.stdout}\n${moved.stderr}`).toContain(
      `session ${uuid(1)}: review-12 -> review-13`,
    );
    expect(await registered("review-12")).toEqual([]);
    expect(await registered("review-13")).toEqual(at(1));
    expect((await prompt(repo, 1)).stdout).toBe("");
    const all = await mshape(repo, ["msg", "inbox", "--all"], undefined);
    expect(all.stdout).toContain("review-12: 1 unread");
    expect(all.stdout).toContain("unread at twelve");
  });

  test("`mshape review rm <n>`: that address's registrations are removed; its unread mail is listed first", async () => {
    await claudeSession(1);
    await start(repo, 1);
    await mshape(repo, ["review", "12"], 1);
    await send(wt("docs"), "review-12", "left unread");
    const removed = await mshape(repo, ["review", "rm", "12"], 1);
    expect(removed.code).toBe(0);
    const said = `${removed.stderr}\n${removed.stdout}`;
    expect(said).toContain("left unread");
    expect(said.indexOf("left unread")).toBeLessThan(said.indexOf(`removed ${reviewWt(12)}`));
    expect(said).toContain("removed 1 registration of review-12");
    expect(await registered("review-12")).toEqual([]);
  });

  test("`/clear` or a restart in a review session: registers at main again, until `mshape review <n>` reruns", async () => {
    await claudeSession(1);
    await start(repo, 1);
    await mshape(repo, ["review", "12"], 1);
    // A compaction keeps the session id, so it keeps the address.
    expect((await hook(repo, ["msg", "register"], 1, "compact")).code).toBe(0);
    expect(await registered("review-12")).toEqual(at(1));
    // /clear: the same process, a new session id, which starts where the session runs.
    await writeFile(
      `${claude}/sessions/1001.json`,
      JSON.stringify({
        ...(await Bun.file(`${claude}/sessions/1001.json`).json()),
        sessionId: uuid(5),
      }),
    );
    expect((await hook(repo, ["msg", "register"], 5, "clear", 1001)).code).toBe(0);
    expect(await registered("main")).toEqual(at(5));
    const again = await mshape(repo, ["review", "12"], { session: 5, pid: 1001 });
    expect(again.code).toBe(0);
    expect(await registered("main")).toEqual([]);
    expect(await registered("review-12")).toContain(`${uuid(5)}.json`);
  });

  test("a second live session registers where one already is: both registered; `register` warns", async () => {
    await claudeSession(1, wt("docs"));
    await claudeSession(2, wt("docs"));
    expect((await start(wt("docs"), 1)).stdout).toBe("");
    const second = await start(wt("docs"), 2);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain(`session ${uuid(1)} is also registered at docs`);
    expect(await registered("docs")).toEqual(at(1, 2));
  });

  test("no session identity (no session id or pid): no address, and a note; never a guess", async () => {
    await claudeSession(1);
    await start(repo, 1);
    const bare = await mshape(repo, ["msg", "register"], undefined);
    expect(bare.code).toBe(0);
    expect(bare.stdout).toContain("no session identity");
    const reviewed = await mshape(repo, ["review", "12"], undefined);
    expect(reviewed.code).toBe(0);
    expect(`${reviewed.stdout}\n${reviewed.stderr}`).toContain("no session identity");
    // The one session at main was not taken for the caller.
    expect(await registered("main")).toEqual(at(1));
    expect(await registered("review-12")).toEqual([]);
  });

  test("which session to move is ambiguous: refuses, naming the sessions", async () => {
    // A /clear just now: the process's old session and its new one are both still running.
    await claudeSession(1);
    await start(repo, 1);
    await age("main");
    await hook(repo, ["msg", "register"], 2, "clear", 1001);
    const ambiguous = await mshape(repo, ["review", "12"], { pid: 1001 });
    expect(ambiguous.code).not.toBe(0);
    const said = `${ambiguous.stdout}\n${ambiguous.stderr}`;
    expect(said).toContain(uuid(1));
    expect(said).toContain(uuid(2));
    expect(await registered("review-12")).toEqual([]);
    expect(await registered("main")).toEqual(at(1, 2));
  });

  test("a live session that never registered (its hook didn't run): no live notices; its inbox hook lists its checkout's unread mail, says it isn't registered, and says to run `mshape msg register`", async () => {
    const received = await claudeSession(1, wt("docs"));
    const sent = await send(wt("tracks"), "docs", "for docs");
    expect(sent.stdout).toContain("No live session of docs to notify");
    expect(received).toEqual([]);
    const inbox = await prompt(wt("docs"), 1);
    expect(inbox.code).toBe(0);
    expect(inbox.stdout).toContain("for docs");
    expect(inbox.stdout).toContain("isn't registered");
    expect(inbox.stdout).toContain("bun run --silent mshape msg register");
  });

  test("`track rm <name>` while an unregistered session runs in its worktree: refuses, naming the session", async () => {
    await mkdir(`${wt("tracks")}/src`, { recursive: true });
    // A live process (this test's), recorded as a session inside the worktree; never registered.
    await writeFile(
      `${claude}/sessions/${process.pid}.json`,
      JSON.stringify({
        pid: process.pid,
        cwd: `${wt("tracks")}/src`,
        sessionId: uuid(7),
        procStart: "p",
        peerProtocol: 1,
        messagingSocketPath: `${base}/none.sock`,
      }),
    );
    const removed = await mshape(repo, ["track", "rm", "tracks"], undefined);
    expect(removed.code).not.toBe(0);
    expect(`${removed.stdout}\n${removed.stderr}`).toContain(uuid(7));
    expect(await registered("tracks")).toEqual([]);
  });

  test("a registration whose session ended: pruned by `send`, never by a read", async () => {
    await claudeSession(1, wt("docs"));
    await start(wt("docs"), 1);
    await age("docs");
    await rm(`${claude}/sessions/1001.json`);
    // Reads: the inbox hook, `msg inbox`, track rm's view of the sessions.
    await prompt(wt("docs"), 1);
    await mshape(wt("docs"), ["msg", "inbox"], undefined);
    expect(await Effect.runPromise(liveSessions(repo, "docs", claude, new Date()))).toEqual([]);
    expect(await registered("docs")).toEqual(at(1));
    const sent = await send(wt("tracks"), "docs", "s");
    expect(sent.stdout).toContain("its Claude Code session has ended");
    expect(await registered("docs")).toEqual([]);
  });
});

describe("addresses beyond the table", () => {
  test("a track can't take an address's name", async () => {
    for (const name of ["main", "review-12"]) {
      const made = await mshape(repo, ["track", "new", name], undefined);
      expect(made.code).not.toBe(0);
      expect(`${made.stdout}\n${made.stderr}`).toContain("address");
    }
  });

  test("`msg send review-<n>` needs that review's worktree", async () => {
    const sent = await send(wt("docs"), "review-99", "s");
    expect(sent.code).not.toBe(0);
    expect(`${sent.stdout}\n${sent.stderr}`).toContain("review-99");
  });
});
