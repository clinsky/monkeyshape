/**
 * `mshape track list`, and how list and rm read beads and pull requests: real git, temp repos
 * with real worktrees, driven through the CLI. The shared harness is `./tracksHarness.ts`.
 */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  base,
  branches,
  exists,
  fakeGh,
  handoff,
  mshape,
  mshapeWith,
  repo,
  setup,
  sh,
  useTrackRepo,
  wt,
} from "./tracksHarness.ts";

useTrackRepo();

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

  test("list never rewrites an older handoff: it reads it as migrated and names `track migrate`", async () => {
    await setup();
    mshape(repo, "new", "docs");
    mshape(repo, "new", "init");
    const text = await Bun.file(handoff("docs")).text();
    const charter = "Serves: goal 2, because x.\nOut of scope: y.\nDone means: z.";
    const current = text.replace("## Charter", `## Charter\n\n${charter}`);
    const old = `${current.replace("Queue:", "Status: active\nQueue:")}\n## Messages\n\n- From init: hello.\n`;
    await writeFile(handoff("docs"), old);
    const initText = await Bun.file(handoff("init")).text();
    const initOld = `${initText}\n## Messages\n\nNone yet.\n`;
    await writeFile(handoff("init"), initOld);

    for (const _ of [1, 2]) {
      const listed = mshape(repo, "list");
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain(
        "note: .handoffs/docs.md is in an older format; `bun run --silent mshape track migrate` upgrades it (moved `## Messages` into the track's mailbox; removed `Status: active`)",
      );
      expect(listed.stdout).toContain(
        "note: .handoffs/init.md is in an older format; `bun run --silent mshape track migrate` upgrades it (removed `## Messages`, which held nothing)",
      );
      expect(listed.stdout).toMatch(/^docs\s+active\s/m);
      expect(listed.stdout).toMatch(/^init\s+stub\s/m);
      expect(listed.stdout).not.toContain("migrated");
      expect(await Bun.file(handoff("docs")).text()).toBe(old);
      expect(await Bun.file(handoff("init")).text()).toBe(initOld);
      expect(await readdir(`${repo}/.git/monkeyshape/mail`).catch(() => [])).toEqual([]);
    }

    const migrated = mshape(repo, "migrate");
    expect(migrated.code).toBe(0);
    expect(migrated.stdout).toMatch(
      /^migrated \.handoffs\/docs\.md: moved `## Messages` into the track's mailbox; removed `Status: active` \(message \d{8}-\d{6}-[0-9a-f]{4}\)$/m,
    );
    expect(migrated.stdout).toContain(
      "migrated .handoffs/init.md: removed `## Messages`, which held nothing",
    );
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
    expect(message.body).toContain("`mshape track migrate`");

    // Once is enough: nothing left to migrate, and list has nothing to say about it.
    expect(mshape(repo, "migrate").stdout).toBe(
      "every handoff is in the current format; nothing changed",
    );
    expect(mshape(repo, "list").stdout).not.toContain("older format");
  });
});

describe("track migrate", () => {
  test("a handoff it can't migrate is left as it was, said, and fails the command", async () => {
    // #57 review, probe P1: the mail its Messages go to can't be written.
    await setup();
    mshape(repo, "new", "docs");
    const old = `${await Bun.file(handoff("docs")).text()}\n## Messages\n\n- From init: hello.\n`;
    await writeFile(handoff("docs"), old);
    await mkdir(`${repo}/.git/monkeyshape`, { recursive: true });
    await writeFile(`${repo}/.git/monkeyshape/mail`, "not a directory\n");
    const migrated = mshape(repo, "migrate");
    expect(migrated.code).toBe(1);
    // A failing command speaks on stderr, like every other.
    expect(migrated.stderr).toContain(
      "note: .handoffs/docs.md is in the older format and wasn't migrated: its Messages couldn't be mailed to docs",
    );
    expect(await Bun.file(handoff("docs")).text()).toBe(old);
  });
});

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
