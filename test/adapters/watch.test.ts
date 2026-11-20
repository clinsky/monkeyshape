/**
 * `mshape msg watch` against real git: a temp repo with real track worktrees, and a fake
 * observer standing in for gh and bd, so each row of the plan's Watches table about storage,
 * sessions and failure runs here; the rows that are decisions are in `test/core/watch.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import {
  checkWatches,
  ghObserver,
  type Lookup,
  type Observer,
  watchAdd,
} from "../../src/adapters/watch.ts";
import type { Message } from "../../src/core/mail.ts";
import type { BeadSeen, PrSeen, Run } from "../../src/core/watch.ts";
import { useSavedDir } from "./savedDir.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
const SHA = "1a45d74188efdd0e72913e84a34ffa7a18a4ee58";
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
    // gh and bd that can't run: the CLI must not reach the real repo's GitHub or beads.
    env: {
      ...process.env,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
      CODEX_THREAD_ID: "",
      PATH: `${base}/bin`,
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

const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
const mailbox = (address: string) => `${repo}/.git/monkeyshape/mail/${address}`;
const unread = async (address: string): Promise<ReadonlyArray<Message>> => {
  const files = await readdir(mailbox(address)).catch(() => [] as Array<string>);
  return Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => JSON.parse(await readFile(`${mailbox(address)}/${file}`, "utf8"))),
  );
};
const watches = (address: string) =>
  readdir(`${mailbox(address)}/watches`).then(
    (files) => files.filter((file) => file.endsWith(".json")).sort(),
    () => [] as Array<string>,
  );

/** What the fake gh and bd see; each test sets what it needs. */
let world: {
  prs: Record<string, Lookup<PrSeen>>;
  beads: Record<string, Lookup<BeadSeen>>;
  runs: Lookup<ReadonlyArray<Run>>;
  asked: Array<string>;
};

const fake: Observer = {
  pr: (_, pr) =>
    Effect.sync(() => {
      world.asked.push(`pr ${pr}`);
      return world.prs[pr] ?? { missing: `pull request #${pr} doesn't exist` };
    }),
  bead: (_, id) =>
    Effect.sync(() => {
      world.asked.push(`bead ${id}`);
      return world.beads[id] ?? { missing: `bead ${id} doesn't exist` };
    }),
  commit: (_, sha) =>
    Effect.sync(() =>
      SHA.startsWith(sha)
        ? { found: { sha: SHA } }
        : { missing: `commit ${sha} on GitHub doesn't exist` },
    ),
  runs: (_, on) =>
    Effect.sync(() => {
      world.asked.push(on === "main" ? "runs main" : `runs ${on.sha}`);
      return world.runs;
    }),
};

const nobody = () => ({
  identity: undefined,
  harnesses: { list: [], io: () => undefined },
  now: new Date(),
});
let clock = Date.parse("2026-11-19T12:00:00Z");
/** Each check a minute after the last, so the rate limit lets it run. */
const later = () => {
  clock += 61_000;
  return new Date(clock);
};
let counter = 0;
const random = () => (counter++ % 65536).toString(16).padStart(4, "0");
const delivered: Array<Message> = [];
const check = (now = later(), cwd = repo) =>
  Effect.runPromise(
    checkWatches(cwd, now, fake, random, (message) =>
      Effect.sync(() => {
        delivered.push(message);
      }),
    ),
  );
const watch = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.runPromise(watchAdd(cwd, args, nobody(), fake, new Date(clock)));

const merged: Lookup<PrSeen> = {
  found: {
    state: "MERGED",
    title: "Add a thing",
    url: "https://example.com/pull/12",
    mergeCommit: SHA,
  },
};
const open: Lookup<PrSeen> = {
  found: { state: "OPEN", title: "Add a thing", url: "https://example.com/pull/12" },
};

useSavedDir(
  "mshape-watch-",
  (dir) => {
    base = dir;
    repo = join(base, "repo");
  },
  async () => {
    await mkdir(repo);
    // A PATH with git and nothing else: gh and bd can't run from the CLI here.
    await mkdir(`${base}/bin`);
    const git = Bun.which("git") ?? "/usr/bin/git";
    await Bun.write(`${base}/bin/git`, `#!/bin/sh\nexec ${git} "$@"\n`);
    Bun.spawnSync(["chmod", "+x", `${base}/bin/git`]);
    sh(repo, "init", "-q", "-b", "main");
    sh(repo, "config", "user.name", "Test");
    sh(repo, "config", "user.email", "test@example.com");
    sh(repo, "config", "commit.gpgsign", "false");
    await writeFile(join(repo, "shape.toml"), 'packs = ["typescript"]\n');
    await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.agents/handoffs\n.handoffs\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "init");
    for (const track of ["docs", "tracks"]) {
      const made = Bun.spawnSync([process.execPath, CLI, "track", "new", track], {
        cwd: repo,
        env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "", CODEX_THREAD_ID: "" },
      });
      expect(made.exitCode).toBe(0);
    }
  },
);

const reset = () => {
  world = { prs: {}, beads: {}, runs: { found: [] }, asked: [] };
  delivered.length = 0;
};

describe("msg watch", () => {
  test("a watched PR merges: one message from mshape, '#N merged' with its merge commit; the watch is removed", async () => {
    reset();
    world.prs["12"] = open;
    expect(await watch(wt("docs"), "pr", "12")).toContain("Watching pr 12 at docs");
    expect(await watches("docs")).toEqual(["pr-12.json"]);
    expect((await check()).sent).toEqual([]);
    world.prs["12"] = merged;
    const { sent } = await check();
    expect(sent.map((m) => [m.from, m.to, m.subject])).toEqual([
      ["mshape", "docs", "#12 merged: Add a thing"],
    ]);
    expect(sent[0]?.body).toContain(SHA);
    expect(delivered).toEqual(sent);
    expect(await watches("docs")).toEqual([]);
    expect((await unread("docs")).map((m) => m.subject)).toEqual(["#12 merged: Add a thing"]);
  });

  test("a watched PR closes unmerged, a bead closes, CI on a head ends: one message each; each removed", async () => {
    reset();
    world.prs["7"] = open;
    world.beads["repo-1a"] = { found: { status: "open", title: "Do it" } };
    await watch(wt("docs"), "pr", "7");
    await watch(wt("docs"), "bead", "repo-1a");
    await watch(wt("docs"), "ci", SHA.slice(0, 7));
    expect(await watches("docs")).toEqual([`bead-repo-1a.json`, `ci-${SHA}.json`, "pr-7.json"]);
    world.prs["7"] = { found: { state: "CLOSED", title: "Nope", url: "u" } };
    world.beads["repo-1a"] = {
      found: { status: "closed", title: "Do it", closeReason: "Done in #7" },
    };
    world.runs = {
      found: [
        {
          sha: SHA,
          workflow: "ci",
          status: "completed",
          conclusion: "failure",
          url: "https://example.com/runs/9",
          title: "t",
          created: "2026-11-19T12:00:00Z",
        },
      ],
    };
    const subjects = (await check()).sent.map((m) => m.subject).sort();
    expect(subjects).toEqual([
      "#7 closed without merging: Nope",
      "CI failed on 1a45d74: ci",
      "repo-1a closed: Do it",
    ]);
    expect(await watches("docs")).toEqual([]);
  });

  test("main's CI fails on a new head, then is green again: one message each, and the watch stays", async () => {
    reset();
    await watch(wt("docs"), "main");
    const head = (sha: string, conclusion: string, minutes: number): Run => ({
      sha,
      workflow: "ci",
      status: "completed",
      conclusion,
      url: "u",
      title: `Merge pull request #${minutes} from someone/x`,
      created: new Date(clock + minutes * 60_000).toISOString(),
    });
    world.runs = { found: [head("a".repeat(40), "failure", 1)] };
    expect((await check()).sent.map((m) => m.subject)).toEqual(["main is red at aaaaaaa (#1)"]);
    world.runs = {
      found: [head("b".repeat(40), "success", 2), head("a".repeat(40), "failure", 1)],
    };
    expect((await check()).sent.map((m) => m.subject)).toEqual([
      "main is green again at bbbbbbb (#2)",
    ]);
    expect(await watches("docs")).toEqual(["main.json"]);
  });

  test("an event already sent is never sent twice, across sessions and restarts", async () => {
    reset();
    world.prs["12"] = open;
    await watch(wt("docs"), "pr", "12");
    const kept = await readFile(`${mailbox("docs")}/watches/pr-12.json`, "utf8");
    world.prs["12"] = merged;
    expect((await check()).sent).toHaveLength(1);
    // A second session that read the watch before the first removed it, checking after.
    await writeFile(`${mailbox("docs")}/watches/pr-12.json`, kept);
    expect((await check()).sent).toEqual([]);
    expect(await unread("docs")).toHaveLength(1);
    expect(await watches("docs")).toEqual([]);
  });

  test("watched again after it fired, it fires again: a re-run of CI on the same head, a PR reopened", async () => {
    reset();
    world.prs["12"] = open;
    await watch(wt("docs"), "pr", "12");
    world.prs["12"] = merged;
    expect((await check()).sent).toHaveLength(1);
    world.prs["12"] = open;
    expect(await watch(wt("docs"), "pr", "12")).toContain("Watching pr 12 at docs");
    world.prs["12"] = merged;
    expect((await check()).sent.map((m) => m.subject)).toEqual(["#12 merged: Add a thing"]);
    expect(await watches("docs")).toEqual([]);

    const ended = (conclusion: string): Run => ({
      sha: SHA,
      workflow: "ci",
      status: "completed",
      conclusion,
      url: "u",
      title: "t",
      created: "2026-11-19T12:00:00Z",
    });
    world.runs = { found: [ended("failure")] };
    await watch(wt("docs"), "ci", SHA);
    expect((await check()).sent.map((m) => m.subject)).toEqual(["CI failed on 1a45d74: ci"]);
    await watch(wt("docs"), "ci", SHA);
    world.runs = { found: [ended("success")] };
    expect((await check()).sent.map((m) => m.subject)).toEqual(["CI passed on 1a45d74"]);
  });

  test("a gh that can't answer is asked once per check, however many things it watches", async () => {
    reset();
    for (const pr of ["7", "8", "9"]) world.prs[pr] = open;
    for (const pr of ["7", "8", "9"]) await watch(wt("docs"), "pr", pr);
    await watch(wt("docs"), "main");
    for (const pr of ["7", "8", "9"])
      world.prs[pr] = { unavailable: "`gh pr view` failed: timed out after 10s" };
    world.asked = [];
    const { notes } = await check();
    expect(world.asked).toHaveLength(1);
    expect(notes[0]).toContain("not asked, since `gh pr view` failed: timed out after 10s");
    expect(await watches("docs")).toEqual(["main.json", "pr-7.json", "pr-8.json", "pr-9.json"]);
  });

  test("two addresses watch one PR: each gets its message, and gh is asked once", async () => {
    reset();
    world.prs["12"] = open;
    await watch(wt("docs"), "pr", "12");
    await watch(repo, "pr", "12");
    world.asked = [];
    world.prs["12"] = merged;
    const { sent } = await check();
    expect(sent.map((m) => m.to).sort()).toEqual(["docs", "main"]);
    expect(world.asked).toEqual(["pr 12"]);
  });

  test("gh or bd can't run: no message, no watch lost, one note at most once an hour", async () => {
    reset();
    world.prs["12"] = open;
    await watch(wt("docs"), "pr", "12");
    world.prs["12"] = { unavailable: "`gh pr view 12` failed: no network" };
    const first = await check();
    expect(first.sent).toEqual([]);
    expect(first.notes).toEqual([
      "note: mshape msg watch couldn't check pr 12: `gh pr view 12` failed: no network. No watch was lost: each is checked again at the next inbox, and this note shows at most once an hour.",
    ]);
    expect((await check()).notes).toEqual([]);
    expect(await watches("docs")).toEqual(["pr-12.json"]);
    clock += 3_600_000;
    expect((await check()).notes).toHaveLength(1);
    world.prs["12"] = merged;
    expect((await check()).sent).toHaveLength(1);
  });

  test("every session idle: the next inbox anywhere checks, at most once a minute across sessions", async () => {
    reset();
    world.prs["12"] = open;
    await watch(wt("docs"), "pr", "12");
    const now = later();
    await check(now, wt("tracks"));
    world.prs["12"] = merged;
    // Within the minute, from another checkout: nothing asked, nothing sent.
    world.asked = [];
    expect((await check(new Date(now.getTime() + 30_000), repo)).sent).toEqual([]);
    expect(world.asked).toEqual([]);
    expect((await check(new Date(now.getTime() + 61_000), repo)).sent.map((m) => m.to)).toEqual([
      "docs",
    ]);
  });

  test("watching a PR, bead or commit that doesn't exist fails at watch time, naming it", async () => {
    reset();
    for (const [args, said] of [
      [["pr", "99"], "pull request #99 doesn't exist: nothing to watch"],
      [["bead", "repo-zz"], "bead repo-zz doesn't exist: nothing to watch"],
      [["ci", "abcdef0"], "commit abcdef0 on GitHub doesn't exist: nothing to watch"],
    ] as const)
      await expect(watch(wt("docs"), ...args)).rejects.toMatchObject({ reason: said });
    expect(await watches("docs")).toEqual([]);
  });
});

describe("msg watch through the CLI", () => {
  test("a reply to mshape fails, saying to message the track instead; no track may be named mshape", () => {
    const sent = mshape(wt("docs"), "msg", "send", "mshape", "--subject", "thanks");
    expect(sent.code).toBe(1);
    expect(sent.stderr).toContain(
      "`mshape` sends the mail of `mshape msg watch` and takes none: to talk about what it reported, message the track concerned",
    );
    expect(mshape(repo, "track", "new", "mshape").stderr).toContain(
      "is the sender of `mshape msg watch`'s mail",
    );
  });

  test("watch, list, unwatch main; gh can't run here, so a PR watch is refused, saying why", () => {
    expect(mshape(wt("docs"), "msg", "watch", "main").stdout).toContain("Watching main at docs");
    expect(mshape(wt("docs"), "msg", "watch", "main").stdout).toBe(
      "Already watching main at docs.",
    );
    expect(mshape(wt("docs"), "msg", "watch").stdout).toContain("  main");
    expect(mshape(wt("docs"), "msg", "unwatch", "main").stdout).toBe(
      "Stopped watching main at docs.",
    );
    expect(mshape(wt("docs"), "msg", "unwatch", "main").stderr).toContain(
      "docs isn't watching main",
    );
    const refused = mshape(wt("docs"), "msg", "watch", "pr", "12");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("can't check that #12 exists, so no watch was made");
  });

  test("an inbox where gh can't run lists the mail, with the note, and never fails", () => {
    expect(mshape(wt("docs"), "msg", "watch", "main").code).toBe(0);
    const inbox = mshape(wt("docs"), "msg", "inbox", "--quiet");
    expect(inbox.code).toBe(0);
    expect(inbox.stdout).toContain("note: mshape msg watch couldn't check main:");
  });

  test("the watcher's track removed: its watches go with its mailbox", async () => {
    expect(mshape(wt("docs"), "msg", "watch", "main").code).toBe(0);
    expect(await watches("docs")).toEqual(["main.json"]);
    expect(mshape(repo, "track", "rm", "docs").code).toBe(0);
    expect(await watches("docs")).toEqual([]);
  });
});

describe("the gh observer", () => {
  /** `ghObserver` with a fake `gh` first on its PATH, running `script`. */
  const withGh = async <A>(script: string, run: (gh: Observer) => Effect.Effect<A>): Promise<A> => {
    await Bun.write(`${base}/bin/gh`, `#!/bin/sh\n${script}\n`);
    Bun.spawnSync(["chmod", "+x", `${base}/bin/gh`]);
    return Effect.runPromise(run(ghObserver({ PATH: `${base}/bin:/usr/bin:/bin` })));
  };

  test("a commit gh resolves is found as its full id; one it has no record of is missing", async () => {
    expect(await withGh(`echo ${SHA}`, (gh) => gh.commit(repo, "1a45d74"))).toEqual({
      found: { sha: SHA },
    });
    expect(
      await withGh("echo 'gh: No commit found for SHA: abcdef0 (HTTP 422)' >&2; exit 1", (gh) =>
        gh.commit(repo, "abcdef0"),
      ),
    ).toEqual({ missing: "commit abcdef0 on GitHub doesn't exist" });
  });

  test("a PR gh can't find is missing; any other failure is unavailable, with gh's words", async () => {
    expect(
      await withGh(
        "echo 'GraphQL: Could not resolve to a PullRequest with the number of 9.' >&2; exit 1",
        (gh) => gh.pr(repo, "9"),
      ),
    ).toEqual({ missing: "pull request #9 doesn't exist" });
    expect(
      await withGh("echo 'error connecting to api.github.com' >&2; exit 1", (gh) =>
        gh.pr(repo, "9"),
      ),
    ).toEqual({ unavailable: "`gh pr view 9` failed: error connecting to api.github.com" });
  });
});
