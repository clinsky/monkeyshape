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
    // Pinned: these tests may run inside a Claude Code session, whose own ids must not leak in.
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "" },
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

  test("after --, a body may start with --", () => {
    const sent = mshape(
      wt("docs"),
      "msg",
      "send",
      "tracks",
      "--subject",
      "s",
      "--",
      "--force is gone",
    );
    expect(sent.code).toBe(0);
    const id = /Sent (\S+)/.exec(sent.stdout)?.[1] ?? "";
    expect(mshape(wt("tracks"), "msg", "read", id).stdout).toEndWith("\n\n--force is gone");
  });

  test("--body-file: the body arrives byte for byte, quotes and a leading -- included", async () => {
    const body = `it's "quoted", with a $HOME and a \`backtick\`\n--force on its own line\n`;
    await writeFile(join(base, "body.md"), body);
    // Relative to the directory the command runs in, as any path argument is.
    await writeFile(join(wt("docs"), "rel.md"), "relative");
    const sent = mshape(
      wt("docs"),
      "msg",
      "send",
      "tracks",
      "--subject",
      "s",
      "--body-file",
      join(base, "body.md"),
    );
    expect(sent.code).toBe(0);
    const id = /Sent (\S+)/.exec(sent.stdout)?.[1] ?? "";
    expect(mshape(wt("tracks"), "msg", "read", id).stdout).toEndWith(`\n\n${body.trimEnd()}`);
    const relative = mshape(
      wt("docs"),
      "msg",
      "send",
      "tracks",
      "--body-file",
      "rel.md",
      "--subject",
      "r",
    );
    expect(relative.code).toBe(0);
    const rid = /Sent (\S+)/.exec(relative.stdout)?.[1] ?? "";
    expect(mshape(wt("tracks"), "msg", "read", rid).stdout).toEndWith("\n\nrelative");
  });

  test("--body-file refuses a missing file, and a body given both ways; nothing is sent", async () => {
    const missing = mshape(
      wt("docs"),
      "msg",
      "send",
      "tracks",
      "--subject",
      "s",
      "--body-file",
      "nope.md",
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("--body-file nope.md: can't read it");
    await writeFile(join(base, "b.md"), "b");
    const both = mshape(
      wt("docs"),
      "msg",
      "send",
      "tracks",
      "--subject",
      "s",
      "--body-file",
      join(base, "b.md"),
      "inline",
    );
    expect(both.code).toBe(2);
    const dangling = mshape(wt("docs"), "msg", "send", "tracks", "--subject", "s", "--body-file");
    expect(dangling.code).toBe(2);
    expect(await files(mailbox("tracks"))).toEqual([]);
  });

  test("--all: one message to every track but the sender's own", async () => {
    expect(mshape(repo, "track", "new", "third").code).toBe(0);
    const fromMain = mshape(repo, "msg", "send", "--all", "--subject", "to everyone", "the body");
    expect(fromMain.code).toBe(0);
    for (const track of ["docs", "third", "tracks"]) {
      expect(fromMain.stdout).toContain(` to ${track}:`);
      const inbox = mshape(wt(track), "msg", "inbox");
      expect(inbox.stdout).toContain("from main, ");
      expect(inbox.stdout).toContain(": to everyone");
    }
    // From a track: the others, never itself.
    const fromDocs = mshape(wt("docs"), "msg", "send", "--all", "--subject", "from docs");
    expect(fromDocs.code).toBe(0);
    expect(fromDocs.stdout).not.toContain(" to docs:");
    expect(mshape(wt("docs"), "msg", "inbox").stdout).not.toContain("from docs");
    expect(mshape(wt("third"), "msg", "inbox").stdout).toContain(": from docs");
    expect(mshape(wt("tracks"), "msg", "inbox").stdout).toContain(": from docs");
  });

  test("--all with a recipient, or with no other track, is refused", async () => {
    expect(mshape(repo, "msg", "send", "--all", "docs", "--subject", "s", "body").code).toBe(2);
    // A recipient left beside --all, with no body: refused, never broadcast as the body.
    for (const recipient of ["docs", "main", "review-12"]) {
      const lone = mshape(repo, "msg", "send", recipient, "--all", "--subject", "s");
      expect(lone.code).toBe(2);
      expect(lone.stderr).toContain(`\`${recipient}\` reads as a recipient`);
    }
    expect(await files(mailbox("docs"))).toEqual([]);
    // Meant as the body: after --, it is one.
    const meant = mshape(repo, "msg", "send", "--all", "--subject", "s", "--", "docs");
    expect(meant.code).toBe(0);
    // Any other lone word is the body, as without --all.
    expect(mshape(repo, "msg", "send", "--all", "--subject", "s", "shipped").code).toBe(0);
    expect(mshape(repo, "track", "rm", "tracks", "--force").code).toBe(0);
    const alone = mshape(wt("docs"), "msg", "send", "--all", "--subject", "s");
    expect(alone.code).toBe(1);
    expect(alone.stderr).toContain("there is no track to send to");
  });

  test("from the main checkout the sender is main; an address can't read another's mail", () => {
    const sent = mshape(repo, "msg", "send", "docs", "--subject", "from main");
    const id = /Sent (\S+)/.exec(sent.stdout)?.[1] ?? "";
    expect(mshape(wt("docs"), "msg", "inbox").stdout).toContain("from main, ");
    const elsewhere = mshape(wt("tracks"), "msg", "read", id);
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.stderr).toContain(`no message ${id} for track tracks`);
    expect(mshape(repo, "msg", "read", id).stderr).toContain(`no message ${id} for main`);
    expect(mshape(repo, "msg", "inbox").stdout).toBe("No unread messages for main.");
  });

  test("an unknown recipient, a bad subject or a bad id is refused, and nothing is written", async () => {
    const typo = mshape(wt("docs"), "msg", "send", "track", "--subject", "x");
    expect(typo.code).toBe(1);
    expect(typo.stderr).toContain("no track `track` to send to (addresses: docs, tracks, main)");
    expect(mshape(wt("docs"), "msg", "send", "tracks", "--subject", "a\nb").stderr).toContain(
      "control character",
    );
    const flagBody = mshape(wt("docs"), "msg", "send", "tracks", "--subject", "s", "--- notes");
    expect(flagBody.code).toBe(2);
    expect(flagBody.stderr).toBe(
      "mshape msg send: `--- notes` is read as a flag; to send text that starts with --, put -- before it: `mshape msg send <track> --subject <subject> -- <body>`",
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

  test("--quiet, the hooks' form: silent outside every address, a note for a file that isn't mail", async () => {
    const outside = mshape(base, "msg", "inbox", "--quiet");
    expect(outside).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(mshape(repo, "msg", "inbox", "--quiet")).toEqual({ code: 0, stdout: "", stderr: "" });
    await mkdir(mailbox("docs"), { recursive: true });
    await writeFile(`${mailbox("docs")}/broken.json`, "{");
    const noted = mshape(wt("docs"), "msg", "inbox", "--quiet");
    expect(noted.code).toBe(0);
    expect(noted.stdout).toContain("note: broken.json in docs's mailbox is not a message");
  });

  test("inbox --all, from the main checkout or a worktree: every mailbox, nothing marked read", async () => {
    mshape(wt("docs"), "msg", "send", "tracks", "--subject", "to tracks");
    mshape(wt("tracks"), "msg", "send", "docs", "--subject", "to docs");
    // A mailbox left by a track that is gone.
    await mkdir(mailbox("gone"), { recursive: true });
    await writeFile(
      `${mailbox("gone")}/20261101-120000-abcd.json`,
      JSON.stringify({
        id: "20261101-120000-abcd",
        from: "main",
        to: "gone",
        subject: "left behind",
        body: "",
        created: "2026-11-01T12:00:00.000Z",
      }),
    );
    for (const cwd of [repo, wt("docs")]) {
      const all = mshape(cwd, "msg", "inbox", "--all");
      expect(all.code).toBe(0);
      const lines = all.stdout.split("\n");
      expect(lines[0]).toBe("docs: 1 unread");
      expect(lines[1]).toContain("from tracks, ");
      expect(lines[2]).toBe(
        `gone: 1 unread (no such track: its worktree and handoff are gone; recreate it with \`bun run --silent mshape track new gone\` to read this, or delete ${mailbox("gone")} if it is no longer wanted)`,
      );
      expect(lines[4]).toBe("tracks: 1 unread");
      expect(lines.at(-1)).toStartWith("3 unread in 3 mailboxes.");
    }
    expect(mshape(wt("tracks"), "msg", "inbox").stdout).toContain(": to tracks");
    expect(await files(`${mailbox("tracks")}/read`)).toEqual([]);
  });

  test("inbox --all with nothing unread says so, and takes no other flag", () => {
    expect(mshape(repo, "msg", "inbox", "--all")).toEqual({
      code: 0,
      stdout: "No unread mail anywhere.",
      stderr: "",
    });
    expect(mshape(repo, "msg", "inbox", "--all", "--quiet").code).toBe(2);
  });
});
