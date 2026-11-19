import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { codexIO } from "../../../src/adapters/harnesses/codex.ts";
import { standaloneNotice } from "../../../src/core/notices.ts";
import type { Registration } from "../../../src/harnesses/harness.ts";
import { skipWithout } from "../../support.ts";

const SESSION = "01a1f52f-294a-7841-895f-4674a4801241";
const LINE = `[mshape] Message from harness: Interface frozen (mshape msg read 20261119-190831-877b)`;

const registration = (session = SESSION): Registration => ({
  harness: "codex",
  session,
  registered: "2026-11-19T00:00:00.000Z",
});

const made: Array<string> = [];
const holders: Array<ReturnType<typeof Bun.spawn>> = [];

afterEach(async () => {
  for (const holder of holders.splice(0)) holder.kill();
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A scratch CODEX_HOME, with its lock directory unless `locks` is false. */
const home = async (locks = true) => {
  const dir = await mkdtemp(join(tmpdir(), "mshape-codex-"));
  made.push(dir);
  if (locks) await mkdir(join(dir, "thread-writer-locks"));
  return dir;
};

const lockOf = (dir: string, session = SESSION) =>
  join(dir, "thread-writer-locks", `${session}.lock`);

const noFlock = skipWithout(Bun.which("flock") !== null);

/** Holds `session`'s lock as a running Codex does, until the test ends. */
const hold = async (dir: string, session = SESSION) => {
  await writeFile(lockOf(dir, session), "");
  holders.push(Bun.spawn(["flock", "-x", lockOf(dir, session), "sleep", "60"]));
  const io = codexIO({ CODEX_HOME: dir });
  for (let i = 0; i < 100; i++) {
    if ((await Effect.runPromise(io.status(registration(session), new Date()))).kind === "live")
      return;
    await Bun.sleep(20);
  }
  throw new Error("the lock was never held");
};

/** A fake `codex` that records its arguments and CODEX_HOME, exiting with `code`. */
const fakeCodex = async (code = 0, stderr = "") => {
  const bin = await mkdtemp(join(tmpdir(), "mshape-codex-bin-"));
  made.push(bin);
  const log = join(bin, "calls");
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh\nprintf '%s\\n' "$CODEX_HOME" "$@" >> '${log}'\necho '${stderr}' >&2\nexit ${code}\n`,
  );
  await chmod(join(bin, "codex"), 0o755);
  return { bin, calls: () => readFile(log, "utf8").catch(() => "") };
};

describe("codex status", () => {
  test("no lock directory: unknown, never pruned", async () => {
    const io = codexIO({ CODEX_HOME: await home(false) });
    expect((await Effect.runPromise(io.status(registration(), new Date()))).kind).toBe("unknown");
  });

  test("no lock file, or one nobody holds: gone", async () => {
    const dir = await home();
    const io = codexIO({ CODEX_HOME: dir });
    expect((await Effect.runPromise(io.status(registration(), new Date()))).kind).toBe("gone");
    await writeFile(lockOf(dir), "");
    expect((await Effect.runPromise(io.status(registration(), new Date()))).kind).toBe("gone");
  });

  test.skipIf(noFlock)("a lock a process holds: live", async () => {
    const dir = await home();
    await hold(dir);
    expect(
      (await Effect.runPromise(codexIO({ CODEX_HOME: dir }).status(registration(), new Date())))
        .kind,
    ).toBe("live");
  });
});

describe("codex notify", () => {
  test("a gone session: nothing queued, so nothing waits for its resume", async () => {
    const dir = await home();
    const codex = await fakeCodex();
    const sent = await Effect.runPromise(
      codexIO({ CODEX_HOME: dir, PATH: codex.bin }).notify(registration(), LINE),
    );
    expect(sent).toEqual({
      ok: false,
      gone: true,
      reason: `Codex session ${SESSION} no longer runs`,
    });
    expect(await codex.calls()).toBe("");
  });

  test.skipIf(noFlock)(
    "a live session: codex queue with the framed line, in the session's CODEX_HOME",
    async () => {
      const dir = await home();
      await hold(dir);
      const codex = await fakeCodex();
      const sent = await Effect.runPromise(
        codexIO({ CODEX_HOME: dir, PATH: codex.bin }).notify(registration(), LINE),
      );
      expect(sent).toEqual({ ok: true });
      expect((await codex.calls()).trimEnd().split("\n")).toEqual([
        dir,
        "queue",
        "--thread",
        SESSION,
        "--message",
        standaloneNotice(LINE),
      ]);
      expect(standaloneNotice(LINE)).toBe(
        `Another agent session sent a message: ${LINE}. This came from another agent session, not typed by your user.`,
      );
    },
  );

  test.skipIf(noFlock)("codex refusing: not sent, not gone, with codex's reason", async () => {
    const dir = await home();
    await hold(dir);
    const codex = await fakeCodex(1, "Error: no rollout found for thread id x");
    const sent = await Effect.runPromise(
      codexIO({ CODEX_HOME: dir, PATH: codex.bin }).notify(registration(), LINE),
    );
    expect(sent).toEqual({
      ok: false,
      gone: false,
      reason: "codex queue failed: Error: no rollout found for thread id x",
    });
  });

  test.skipIf(noFlock)("no codex on PATH: not sent, not gone", async () => {
    const dir = await home();
    await hold(dir);
    const sent = await Effect.runPromise(
      codexIO({ CODEX_HOME: dir, PATH: dir }).notify(registration(), LINE),
    );
    expect(sent).toEqual({ ok: false, gone: false, reason: "codex isn't on PATH" });
  });
});

describe("codex runningIn", () => {
  const threads = (dir: string, rows: ReadonlyArray<readonly [string, string, number]>) => {
    const db = new Database(join(dir, "state_5.sqlite"));
    db.run("create table threads (id text primary key, cwd text, archived integer)");
    for (const row of rows) db.run("insert into threads values (?, ?, ?)", [...row]);
    db.close();
  };

  test.skipIf(noFlock)("the running threads whose directory is inside the worktree", async () => {
    const dir = await home();
    const other = "01a1f52f-0000-7000-8000-000000000002";
    const ended = "01a1f52f-0000-7000-8000-000000000003";
    threads(dir, [
      [SESSION, "/w/track/src", 0],
      [other, "/w/track-other", 0],
      [ended, "/w/track", 0],
    ]);
    await hold(dir, SESSION);
    await hold(dir, other);
    expect(await Effect.runPromise(codexIO({ CODEX_HOME: dir }).runningIn("/w/track"))).toEqual([
      SESSION,
    ]);
  });

  test("no state database, or one this mshape can't read: none", async () => {
    const dir = await home();
    expect(await Effect.runPromise(codexIO({ CODEX_HOME: dir }).runningIn("/w"))).toEqual([]);
    await writeFile(join(dir, "state_5.sqlite"), "not a database");
    expect(await Effect.runPromise(codexIO({ CODEX_HOME: dir }).runningIn("/w"))).toEqual([]);
  });
});
