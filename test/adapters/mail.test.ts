/**
 * `mshape msg` against real git: a temp repo with real track worktrees, driven through the
 * CLI, so the mailbox is the one every checkout shares under git's common directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { mailSend } from "../../src/adapters/mail.ts";

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

const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
const mailbox = (track: string) => `${repo}/.git/monkeyshape/mail/${track}`;
const files = (dir: string) => readdir(dir).catch(() => [] as Array<string>);

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-mail-")));
  repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
  await writeFile(join(repo, "shape.config.ts"), "export default {};\n");
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.agents/handoffs\n.handoffs\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  for (const track of ["docs", "tracks"]) expect(mshape(repo, "track", "new", track).code).toBe(0);
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("msg", () => {
  test("a message waits unread until the recipient reads it, then is read for the track", async () => {
    const sent = mshape(
      wt("docs"),
      "msg",
      "send",
      "tracks",
      "--subject",
      "parser changed",
      "body\ntwo lines",
    );
    expect(sent.code).toBe(0);
    const id = /Sent (\S+) to tracks/.exec(sent.stdout)?.[1] ?? "";
    expect(sent.stdout).toContain(`bun run --silent mshape msg read ${id}`);

    // The sender's own inbox is untouched; the recipient's lists it, from any of its sessions.
    expect(mshape(wt("docs"), "msg", "inbox").stdout).toBe("No unread messages for track docs.");
    for (let session = 0; session < 2; session++) {
      const inbox = mshape(wt("tracks"), "msg", "inbox");
      expect(inbox.stdout).toContain(`${id}  from docs, `);
      expect(inbox.stdout).toContain(": parser changed");
      expect(inbox.stdout).not.toContain("two lines");
    }

    const read = mshape(wt("tracks"), "msg", "read", id);
    expect(read.code).toBe(0);
    expect(read.stdout).toContain("From: docs\nTo: tracks\n");
    expect(read.stdout).toEndWith("Subject: parser changed\n\nbody\ntwo lines");
    expect(mshape(wt("tracks"), "msg", "inbox", "--quiet").stdout).toBe("");
    expect(await files(`${mailbox("tracks")}/read`)).toEqual([`${id}.json`]);
    expect(mshape(wt("tracks"), "msg", "read", id).stdout).toContain("(already read)");
  });

  test("from the main checkout the sender is main; a track can't read another's mail", () => {
    const sent = mshape(repo, "msg", "send", "docs", "--subject", "from main");
    const id = /Sent (\S+)/.exec(sent.stdout)?.[1] ?? "";
    expect(mshape(wt("docs"), "msg", "inbox").stdout).toContain("from main, ");
    const elsewhere = mshape(wt("tracks"), "msg", "read", id);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.stderr).toContain(`no message ${id} for track tracks`);
    const main = mshape(repo, "msg", "inbox");
    expect(main.code).toBe(1);
    expect(main.stderr).toContain("Only a track has a mailbox");
  });

  test("an unknown recipient, a bad subject or a bad id is refused, and nothing is written", async () => {
    const typo = mshape(wt("docs"), "msg", "send", "track", "--subject", "x");
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("no track `track` to send to (tracks: docs, tracks)");
    expect(mshape(wt("docs"), "msg", "send", "tracks", "--subject", "a\nb").stderr).toContain(
      "line break",
    );
    expect(mshape(wt("docs"), "msg", "send", "tracks").code).toBe(2);
    expect(mshape(wt("tracks"), "msg", "read", "../docs/x").stderr).toContain("not a message id");
    expect(await files(`${repo}/.git/monkeyshape/mail`)).toEqual([]);
  });

  test("concurrent senders lose nothing, and leave no temporary files", async () => {
    const senders = Array.from({ length: 20 }, (_, i) =>
      Bun.spawn(
        [process.execPath, CLI, "msg", "send", "tracks", "--subject", `n${i}`, `body ${i}`],
        { cwd: i % 2 === 0 ? wt("docs") : repo, stdout: "pipe", stderr: "pipe" },
      ),
    );
    expect(await Promise.all(senders.map((child) => child.exited))).toEqual(Array(20).fill(0));
    const stored = await files(mailbox("tracks"));
    expect(stored.filter((file) => file.endsWith(".json"))).toHaveLength(20);
    expect(stored.filter((file) => file.startsWith("."))).toEqual([]);
    const inbox = mshape(wt("tracks"), "msg", "inbox").stdout;
    const subjects = inbox.split("\n").flatMap((line) => /: (n\d+)$/.exec(line)?.[1] ?? []);
    expect(subjects.sort()).toEqual(Array.from({ length: 20 }, (_, i) => `n${i}`).sort());
  });

  test("an id another sender took is retried, never overwritten", async () => {
    const now = new Date("2026-11-03T14:00:00Z");
    const send = (subject: string, randoms: Array<string>) =>
      Effect.runPromise(
        mailSend(wt("docs"), "tracks", subject, "", now, () => randoms.shift() ?? "ffff"),
      );
    expect((await send("first", ["0000"])).id).toBe("20261103-140000-0000");
    expect((await send("second", ["0000", "0001"])).id).toBe("20261103-140000-0001");
    const first = await Bun.file(`${mailbox("tracks")}/20261103-140000-0000.json`).json();
    expect(first.subject).toBe("first");
  });

  test("--quiet, the hooks' form: silent outside a track, a note for a file that isn't mail", async () => {
    const outside = mshape(base, "msg", "inbox", "--quiet");
    expect(outside).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(mshape(repo, "msg", "inbox", "--quiet")).toEqual({ code: 0, stdout: "", stderr: "" });
    await mkdir(mailbox("docs"), { recursive: true });
    await writeFile(`${mailbox("docs")}/broken.json`, "{");
    const noted = mshape(wt("docs"), "msg", "inbox", "--quiet");
    expect(noted.code).toBe(0);
    expect(noted.stdout).toContain("note: broken.json in docs's mailbox is not a message");
  });
});
