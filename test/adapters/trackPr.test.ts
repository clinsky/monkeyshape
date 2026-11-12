import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prSkeleton } from "../../src/core/conventions.ts";
import { REVIEW_MARKER } from "../../src/core/trackPr.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let base = "";
let repo = "";
let bin = "";
let gh = "";

const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

const wt = () => `${repo}/.agents/worktrees/repo@docs`;

/** `mshape track ...`, with the fake gh first on PATH and no bd; `extra` adds to its env. */
const run = (extra: Record<string, string>, cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, "track", ...args], {
    cwd,
    env: {
      ...process.env,
      ...extra,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_GH: gh,
      CLAUDE_CONFIG_DIR: join(base, "no-claude"),
      // Never this machine's own denylist, nor its Claude sessions.
      XDG_CONFIG_HOME: join(base, "config"),
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
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
const mshape = Object.assign(
  (cwd: string, ...args: ReadonlyArray<string>) => run({}, cwd, ...args),
  {
    withEnv:
      (extra: Record<string, string>) =>
      (cwd: string, ...args: ReadonlyArray<string>) =>
        run(extra, cwd, ...args),
  },
);

/**
 * A fake `gh`: `pr list` prints the PR in $FAKE_GH/pr.json, if any; `pr create` and `pr edit`
 * store the body file there; every call is appended to calls.log. `fail` makes create fail.
 */
const FAKE_GH = `
const [, , ...args] = process.argv;
const dir = process.env.FAKE_GH;
const state = Bun.file(dir + "/pr.json");
await Bun.write(dir + "/calls.log", ((await Bun.file(dir + "/calls.log").exists()) ? await Bun.file(dir + "/calls.log").text() : "") + args.join(" ") + "\\n");
const flag = (name) => args[args.indexOf(name) + 1];
if (args[1] === "list") {
  // As gh 2.4: a JSON field it doesn't know fails the call.
  if (flag("--json").split(",").some((field) => !["number", "url", "body", "title"].includes(field))) {
    console.error("Unknown JSON field: " + flag("--json"));
    process.exit(1);
  }
  console.log((await state.exists()) ? "[" + (await state.text()) + "]" : "[]");
} else if (args[0] === "api" && (args[1] ?? "").split("/").at(-2) === "pulls" && !args.includes("--method")) {
  // The PR's head is what the remote's branch is at, as GitHub reports it.
  const head = Bun.spawnSync(["git", "rev-parse", "refs/heads/track/docs"], { cwd: dir + "/../remote.git" });
  console.log(head.stdout.toString().trim());
} else if (args[0] === "api" && (args[1] ?? "").endsWith("/reviews")) {
  // The reviews, as each query track pr has sent prints them; any other query fails, so a
  // test can't pass on a query the fake doesn't model.
  const file = Bun.file(dir + "/reviews.json");
  const reviews = (await file.exists()) ? JSON.parse(await file.text()) : [];
  const query = flag("-q");
  if (query === ".[] | {commit_id, body} | @json")
    for (const review of reviews) console.log(JSON.stringify({ commit_id: review.commit_id, body: review.body }));
  else if (query === ".[].commit_id") for (const review of reviews) console.log(review.commit_id);
  else {
    console.error("fake gh: unmodelled query " + query);
    process.exit(1);
  }
}
else if (args[0] === "api" && (args[1] ?? "").endsWith("/check-runs")) {
  // CI's check runs: checks.json, or the next of checks-<n>.json on each call.
  if (flag("-q") !== ".check_runs[] | {name, status, conclusion} | @json") { console.error("fake gh: unmodelled query"); process.exit(1); }
  const count = Bun.file(dir + "/polls");
  const n = (await count.exists()) ? Number(await count.text()) : 0;
  await Bun.write(count, String(n + 1));
  const staged = Bun.file(dir + "/checks-" + n + ".json");
  const file = (await staged.exists()) ? staged : Bun.file(dir + "/checks.json");
  if (await file.exists()) for (const run of JSON.parse(await file.text())) console.log(JSON.stringify(run));
}
else if (args[1] === "create") {
  if (await Bun.file(dir + "/fail").exists()) { console.error("HTTP 502"); process.exit(1); }
  const pr = { number: 7, url: "https://example.test/pr/7", title: flag("--title"), body: await Bun.file(flag("--body-file")).text() };
  await Bun.write(state, JSON.stringify(pr));
  console.log(pr.url);
} else if (args[0] === "api" && flag("--method") === "PATCH") {
  // REST: \`-F body=@<file>\` reads the file; \`-f title=<t>\` is a raw string.
  const pr = JSON.parse(await state.text());
  for (const [i, arg] of args.entries()) {
    const value = args[i + 1] ?? "";
    if (arg === "-F" && value.startsWith("body=@")) pr.body = await Bun.file(value.slice(6)).text();
    if (arg === "-f" && value.startsWith("title=")) pr.title = value.slice(6);
  }
  await Bun.write(state, JSON.stringify(pr));
} else {
  // gh pr edit, as old gh versions fail it, and anything unexpected.
  console.error("GraphQL: Projects (classic) is being deprecated");
  process.exit(1);
}
`;

const body = (narrative: string) =>
  prSkeleton({
    "What changed and why": narrative,
    Evidence: "Ran it.",
    "Not done": "Nothing.",
    Beads: "- x-abc.1 the bead",
  });

const pr = async () => JSON.parse(await Bun.file(`${gh}/pr.json`).text());

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-trackpr-")));
  repo = join(base, "repo");
  bin = join(base, "bin");
  gh = join(base, "gh");
  await mkdir(repo);
  await mkdir(bin);
  await mkdir(gh);
  await writeFile(join(base, "gh.js"), FAKE_GH);
  await writeFile(join(bin, "gh"), `#!/bin/sh\nexec "${process.execPath}" "${base}/gh.js" "$@"\n`);
  await chmod(join(bin, "gh"), 0o755);
  sh(base, "init", "-q", "--bare", "-b", "main", "remote.git");
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
  // The gate: passes unless the file `red` exists, and prints a summary to stderr.
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        check:
          'echo gate ran && echo \' 3 pass\' >&2 && { test ! -e red || { echo \'(fail) suite > the red test [0.50ms]\'; exit 1; }; } && { test -z "$NEED" || test -e "$NEED"; } && { test -z "$LATE" || git -C "$LATE" commit -q --allow-empty -m late-unreviewed; }',
      },
    }),
  );
  await writeFile(join(repo, "shape.config.ts"), "export default {};\n");
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.handoffs\nbody.md\nlate\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  sh(repo, "remote", "add", "origin", join(base, "remote.git"));
  sh(repo, "push", "-q", "-u", "origin", "main");
  mshape(repo, "new", "docs");
  await writeFile(`${wt()}/page.md`, "page\n");
  sh(wt(), "add", ".");
  sh(wt(), "commit", "-qm", "page");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const remoteHas = () =>
  Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/heads/track/docs"], {
    cwd: join(base, "remote.git"),
  }).exitCode === 0;

describe("track pr", () => {
  test("opens the PR: size, a fresh gate in the Gate section, the narrative as written", async () => {
    await writeFile(`${wt()}/body.md`, body("Why this page."));
    const opened = mshape(wt(), "pr", "--title", "A page", "--body-file", "body.md");
    expect(opened.stderr).toContain("1 changed lines: below the batching default");
    expect(opened.stderr).toContain("running the gate, `bun run check`");
    expect(opened.stderr).toContain(
      "note: `bd` is not on PATH, so the listed beads weren't checked",
    );
    expect(opened.code).toBe(0);
    expect(opened.stdout).toBe("opened https://example.test/pr/7");
    expect(remoteHas()).toBe(true);
    const created = await pr();
    expect(created.title).toBe("A page");
    expect(created.body).toContain("## What changed and why\n\nWhy this page.\n");
    const head = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    expect(created.body).toContain(`$ bun run check   # at ${head}, run by mshape track pr`);
    expect(created.body).toContain("gate ran");
    expect(created.body).toContain(" 3 pass");
  });

  test("updates the PR: only the Gate is rewritten; a narrative edited on GitHub survives", async () => {
    await writeFile(`${wt()}/body.md`, body("First."));
    mshape(wt(), "pr", "--title", "A page", "--body-file", "body.md");
    // The agent edits the narrative on GitHub, and commits more.
    const edited = await pr();
    edited.body = edited.body.replace("First.", "Edited by hand on GitHub.");
    await writeFile(`${gh}/pr.json`, JSON.stringify(edited));
    await writeFile(`${wt()}/more.md`, "more\n");
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "more");

    const updated = mshape(wt(), "pr");
    expect(updated.code).toBe(0);
    expect(updated.stdout).toBe(
      "updated https://example.test/pr/7: the Gate section is from this run; every other section is as it was",
    );
    const after = await pr();
    expect(after.body).toContain("Edited by hand on GitHub.");
    expect(after.body).toContain(`# at ${sh(wt(), "rev-parse", "HEAD").slice(0, 12)}`);
    expect(after.body.split("## Gate").length).toBe(2);
    expect(after.title).toBe("A page");
  });

  test("refuses, pushing and posting nothing: no title, uncommitted work, a red gate, a missing section", async () => {
    expect(mshape(wt(), "pr").stderr).toContain(
      "no PR is open from `track/docs`: opening one needs --title",
    );
    await writeFile(`${wt()}/body.md`, body("x").replace("## Evidence\n\nRan it.\n\n", ""));
    await writeFile(`${wt()}/page.md`, "edited, not committed\n");
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").stderr).toContain(
      "`track/docs` has uncommitted changes (M page.md)",
    );
    sh(wt(), "checkout", "--", "page.md");
    const missing = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(missing.stderr).toContain("the body isn't ready, so nothing was pushed or posted:");
    expect(missing.stderr).toContain("the PR body lacks `## Evidence`");

    await writeFile(`${wt()}/body.md`, body("x"));
    await writeFile(`${wt()}/red`, "");
    sh(wt(), "add", "red");
    sh(wt(), "commit", "-qm", "red");
    const red = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(red.code).toBe(1);
    expect(red.stderr).toContain("the gate failed (exit 1) on a clean checkout of");
    expect(red.stderr).toContain("so nothing was pushed or posted");
    expect(red.stderr).toContain("gate ran");
    expect(remoteHas()).toBe(false);
    expect(await Bun.file(`${gh}/pr.json`).exists()).toBe(false);
  });

  test("a commit made while the gate runs isn't pushed: the remote gets the gated commit", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    // The probe from #35's review: the gate makes a commit on the track branch, as a second
    // session might.
    const gated = sh(wt(), "rev-parse", "HEAD");
    const opened = mshape.withEnv({ LATE: wt() })(
      wt(),
      "pr",
      "--title",
      "t",
      "--body-file",
      "body.md",
    );
    expect(opened.code).toBe(0);
    const late = sh(wt(), "rev-parse", "HEAD");
    expect(late).not.toBe(gated);
    const pushed = sh(join(base, "remote.git"), "rev-parse", "refs/heads/track/docs");
    expect(pushed).toBe(gated);
    expect((await pr()).body).toContain(`# at ${gated.slice(0, 12)}`);
    expect(opened.stderr).toContain(
      `note: \`track/docs\` moved to ${late.slice(0, 12)} while the gate ran; pushed ${gated.slice(0, 12)}, the commit it gated. Run track pr again to gate and push the rest`,
    );
  });

  test("a push the remote refuses as non-fast-forward says what to do about its branch", async () => {
    // The remote's track/docs has a commit of its own, as an earlier track of the name leaves.
    sh(base, "clone", "-q", join(base, "remote.git"), "other");
    for (const key of ["user.name", "user.email"]) sh(join(base, "other"), "config", key, "x");
    sh(join(base, "other"), "checkout", "-q", "-b", "track/docs");
    sh(join(base, "other"), "commit", "-q", "--allow-empty", "-m", "an earlier track's");
    sh(join(base, "other"), "push", "-q", "origin", "track/docs");
    await writeFile(`${wt()}/body.md`, body("x"));
    const refused = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("`origin`'s `track/docs` has commits this branch lacks");
    expect(refused.stderr).toContain("delete it (`git push origin --delete track/docs`)");
  });

  test("a create that fails says whether a PR is open now, so nothing is posted twice", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    await writeFile(`${gh}/fail`, "");
    const failed = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain(
      "`gh pr create` failed: HTTP 502. No PR is open from the branch.",
    );
  });

  test("--check-body reads a body on stdin: exit 0 when complete, 1 naming what's missing", () => {
    const check = (text: string) => {
      const result = Bun.spawnSync([process.execPath, CLI, "track", "pr", "--check-body"], {
        cwd: repo,
        stdin: Buffer.from(text),
        stdout: "pipe",
        stderr: "pipe",
      });
      return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() };
    };
    // What track pr posts has a Gate; the agent's body file need not.
    expect(check(body("x")).out).toContain("lacks `## Gate`");
    expect(check(body("x").replace("## Not done", "## Gate\n\nran\n\n## Not done")).code).toBe(0);
    const bad = check(prSkeleton());
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("the PR body lacks `## What changed and why`");
    // Headings only: a template-following Beads section in another form passes, as #33's
    // (a backticked id and a full stop, on one line) failed in re-review of #35. track pr itself still
    // refuses it, in the core planPrBody test, since it can't check such a bead with bd.
    const proseBeads = check(
      body("x")
        .replace("## Not done", "## Gate\n\nran\n\n## Not done")
        .replace("- x-abc.1 the bead", "`x-def.21`."),
    );
    expect(proseBeads.out).toBe("the PR body has every required section\n");
    expect(proseBeads.code).toBe(0);
  });
});

const remoteTip = () => sh(join(base, "remote.git"), "rev-parse", "refs/heads/track/docs");

/**
 * A reviewer's session registered at `review-7`: live when Claude Code's record of it exists,
 * ended (registered long ago, no record) otherwise.
 */
const reviewer = async (live: boolean) => {
  const session = "11111111-2222-3333-4444-555555555555";
  const pid = 424242;
  const dir = join(repo, ".git", "monkeyshape", "sessions", "review-7");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${session}.json`),
    JSON.stringify({
      session,
      pid,
      registered: live ? new Date().toISOString() : "2026-01-01T00:00:00.000Z",
    }),
  );
  if (live) {
    await mkdir(join(base, "no-claude", "sessions"), { recursive: true });
    await writeFile(
      join(base, "no-claude", "sessions", `${pid}.json`),
      JSON.stringify({
        pid,
        sessionId: session,
        procStart: "p",
        peerProtocol: 1,
        messagingSocketPath: join(base, "none.sock"),
      }),
    );
  }
  return session;
};

/** The reviews the fake `gh` lists on the PR. */
const reviews = (list: ReadonlyArray<{ commit_id: string; body: string }>) =>
  writeFile(`${gh}/reviews.json`, JSON.stringify(list));

/** Opens the PR (#7), then commits more, as answering a review would. */
const openThenCommit = async () => {
  await writeFile(`${wt()}/body.md`, body("x"));
  expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
  await commitFile("fix.md", "fix\n", "a fix");
};

// The plan's review-in-progress table, row by row.
describe("track pr: the branch tip, and a review in progress", () => {
  test("no session at review-<n>: pushes, noting a reviewer elsewhere can't be seen", async () => {
    await openThenCommit();
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(
      "note: no review of #7 is in progress on this machine; a reviewer on another machine can't be seen from here",
    );
    expect(remoteTip()).toBe(sh(wt(), "rev-parse", "HEAD"));
  });

  test("a live reviewer, no review on the PR's head: refused, naming the session; nothing pushed", async () => {
    await openThenCommit();
    const before = remoteTip();
    const session = await reviewer(true);
    const refused = mshape(wt(), "pr");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      `a review of #7 is in progress (session ${session} at \`review-7\`)`,
    );
    expect(refused.stderr).not.toContain("running the gate");
    expect(remoteTip()).toBe(before);
    // An earlier head's review doesn't count: the reviewer is on this one.
    await reviews([{ commit_id: "0".repeat(40), body: "## Fit\n\nround 1" }]);
    expect(mshape(wt(), "pr").code).toBe(1);
  });

  test("a thread reply on the head (an empty-bodied review) isn't the reviewer's review (#79's blocker)", async () => {
    await openThenCommit();
    await reviewer(true);
    // Round 1 on an earlier head; the author's replies in its threads are on the current one.
    await reviews([
      { commit_id: "0".repeat(40), body: "## Fit\n\nround 1" },
      { commit_id: remoteTip(), body: "" },
      { commit_id: remoteTip(), body: "" },
    ]);
    const before = remoteTip();
    const refused = mshape(wt(), "pr");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("a review of #7 is in progress");
    expect(remoteTip()).toBe(before);
  });

  test("once a review is marked by review post, only marked ones count: the author's own review doesn't (#79's nit)", async () => {
    await openThenCommit();
    await reviewer(true);
    await reviews([
      { commit_id: "0".repeat(40), body: `## Fit\n\nround 1\n\n${REVIEW_MARKER}` },
      { commit_id: remoteTip(), body: "A probe by the author, unmarked." },
    ]);
    expect(mshape(wt(), "pr").code).toBe(1);
    await reviews([
      { commit_id: "0".repeat(40), body: `## Fit\n\nround 1\n\n${REVIEW_MARKER}` },
      { commit_id: remoteTip(), body: `## Re-review\n\n${REVIEW_MARKER}` },
    ]);
    expect(mshape(wt(), "pr").code).toBe(0);
  });

  test("a live reviewer whose review is on the PR's head (findings to answer): pushes", async () => {
    await openThenCommit();
    await reviewer(true);
    await reviews([{ commit_id: remoteTip(), body: "## Fit\n\nfindings" }]);
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(remoteTip()).toBe(sh(wt(), "rev-parse", "HEAD"));
  });

  test("the reviewer's session ended without posting: pushes, with a note", async () => {
    await openThenCommit();
    await reviewer(false);
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(
      "note: a reviewer's session at `review-7` ended without posting a review on the PR's head; pushing",
    );
  });

  test("HEAD on another branch with the next bead's commits: gates and pushes track/<name>'s tip only", async () => {
    await openThenCommit();
    const tip = sh(wt(), "rev-parse", "HEAD");
    sh(wt(), "switch", "-q", "-c", "docs-next");
    await commitFile("next.md", "next bead\n", "the next bead");
    // The next bead breaks the gate: only the track branch's tip is gated.
    await commitFile("red", "", "red on the next branch");
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(pushed.stderr).toContain(
      `note: \`docs-next\` is checked out; track pr gates and pushes \`track/docs\` at ${tip.slice(0, 12)}, and nothing else`,
    );
    expect(remoteTip()).toBe(tip);
    expect((await pr()).body).toContain(`# at ${tip.slice(0, 12)}`);
  });

  test("the gate runs on a clean checkout: a file only the worktree has can't pass it", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    // The gate needs support.txt, which exists in the worktree but was never committed.
    await writeFile(`${wt()}/support.txt`, "here, untracked\n");
    const failed = mshape.withEnv({ NEED: "support.txt" })(
      wt(),
      "pr",
      "--title",
      "t",
      "--body-file",
      "body.md",
    );
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("note: untracked files aren't gated or pushed (support.txt)");
    expect(failed.stderr).toContain("the gate failed (exit 1) on a clean checkout");
    expect(remoteHas()).toBe(false);
    sh(wt(), "add", "support.txt");
    sh(wt(), "commit", "-qm", "support");
    expect(
      mshape.withEnv({ NEED: "support.txt" })(wt(), "pr", "--title", "t", "--body-file", "body.md")
        .code,
    ).toBe(0);
  });

  test("a failing gate names its failing tests and keeps the whole log", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    await commitFile("red", "", "red");
    const failed = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("Failing tests (1):\n  suite > the red test\n");
    const log = join(repo, ".git", "monkeyshape", "gate", "docs.log");
    expect(failed.stderr).toContain(`The whole output: ${log}`);
    expect(await Bun.file(log).text()).toContain("gate ran");
    // The scratch checkout is gone either way.
    expect(
      await Bun.file(join(repo, ".agents", "worktrees", "repo.gate-docs", "page.md")).exists(),
    ).toBe(false);
  });
});

const checks = (name: string, runs: ReadonlyArray<object>) =>
  writeFile(`${gh}/${name}`, JSON.stringify(runs));

// The plan's --body-only and behind rows, and --wait.
describe("track pr: --body-only, behind main, --wait", () => {
  test("--body-only with the tip unchanged since the gate: edits the body, no push, no gate", async () => {
    await writeFile(`${wt()}/body.md`, body("First."));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    const gate = (await pr()).body.split("## Gate")[1].split("## ")[0];
    await writeFile(`${wt()}/body.md`, body("Reworded while the PR waits."));
    const edited = mshape(wt(), "pr", "--body-only", "--body-file", "body.md");
    expect(edited.code).toBe(0);
    expect(edited.stderr).not.toContain("running the gate");
    expect(edited.stdout).toContain("the body only, with no push and no gate");
    const after = await pr();
    expect(after.body).toContain("Reworded while the PR waits.");
    expect(after.body.split("## Gate")[1].split("## ")[0]).toBe(gate);
  });

  test("--body-only with the tip moved: refused, since the Gate section would be false", async () => {
    await writeFile(`${wt()}/body.md`, body("First."));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    const pushed = remoteTip();
    await commitFile("more.md", "more\n", "more");
    const refused = mshape(wt(), "pr", "--body-only", "--body-file", "body.md");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--body-only would leave the Gate section false");
    expect(refused.stderr).toContain("Nothing was posted");
    expect(remoteTip()).toBe(pushed);
    expect((await pr()).body).toContain("First.");
  });

  test("--body-only with no PR open: refused", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--body-only", "--body-file", "body.md").stderr).toContain(
      "no PR is open from `track/docs`",
    );
  });

  test("behind main: pushes, warning how far; conflicting: names the files", async () => {
    await writeFile(join(repo, "other.md"), "main's\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "main moves");
    sh(repo, "push", "-q", "origin", "main");
    await writeFile(`${wt()}/body.md`, body("x"));
    const behind = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(behind.code).toBe(0);
    expect(behind.stderr).toContain("warning: the branch is 1 commit behind `origin/main`.");

    await writeFile(join(repo, "page.md"), "main's own page\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "main writes the page too");
    sh(repo, "push", "-q", "origin", "main");
    await commitFile("more.md", "more\n", "more");
    const conflicting = mshape(wt(), "pr");
    expect(conflicting.code).toBe(0);
    expect(conflicting.stderr).toContain(
      "warning: the branch is 2 commits behind `origin/main`, and conflicts with it in page.md.",
    );
  });

  test("up to date with main: no warning", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").stderr).not.toContain(
      "warning:",
    );
  });

  test("--wait returns CI's outcome: passed, or exit 1 naming the failed check", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    await checks("checks.json", [
      { name: "check", status: "completed", conclusion: "success" },
      { name: "body", status: "completed", conclusion: "success" },
    ]);
    const passed = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md", "--wait");
    expect(passed.code).toBe(0);
    expect(passed.stdout).toContain(`CI passed on ${remoteTip().slice(0, 12)}:\n  check: success`);

    await checks("checks.json", [
      { name: "check", status: "completed", conclusion: "failure" },
      { name: "body", status: "completed", conclusion: "success" },
    ]);
    const failed = mshape(wt(), "pr", "--body-only", "--wait");
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("but CI failed on");
    expect(failed.stderr).toContain("check (failure)");
  });

  /** `awaitCi` in a child process, its env pointing at the fake gh: stdout, or the failure. */
  const awaitCiRun = async (sha: string, timing: object, conflicts = false) => {
    const script = join(base, "await.ts");
    await writeFile(
      script,
      // By absolute path: the script is in a temp directory, with no node_modules above it.
      `import { Effect } from ${JSON.stringify(Bun.resolveSync("effect", import.meta.dir))};
import { awaitCi } from ${JSON.stringify(join(import.meta.dir, "..", "..", "src", "adapters", "trackPr.ts"))};
const out = await Effect.runPromise(
  awaitCi(process.cwd(), ${JSON.stringify(sha)}, "updated", ${JSON.stringify(timing)}, (line) => Effect.sync(() => console.error(line)), ${conflicts}),
);
console.log(out);
`,
    );
    // --no-install: as CI, where bun never fetches a missing package.
    const result = Bun.spawnSync([process.execPath, "--no-install", script], {
      cwd: wt(),
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, FAKE_GH: gh },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { stdout: result.stdout.toString().trim(), stderr: result.stderr.toString().trim() };
  };

  test("awaitCi polls until every check has finished", async () => {
    await checks("checks-0.json", []);
    await checks("checks-1.json", [{ name: "check", status: "in_progress", conclusion: null }]);
    await checks("checks-2.json", [{ name: "check", status: "completed", conclusion: "success" }]);
    const ran = await awaitCiRun("a".repeat(40), { pollMs: 5, startMs: 10_000, limitMs: 10_000 });
    expect(ran).toEqual({
      stdout: "updated\nCI passed on aaaaaaaaaaaa:\n  check: success",
      stderr: "waiting for CI on aaaaaaaaaaaa",
    });
    expect(await Bun.file(`${gh}/polls`).text()).toBe("3");
  });

  test("awaitCi with no check starting: says so, and stops waiting", async () => {
    const ran = await awaitCiRun("b".repeat(40), { pollMs: 5, startMs: 20, limitMs: 10_000 });
    expect(`${ran.stdout}\n${ran.stderr}`).toContain("note: no CI check started on bbbbbbbbbbbb");
    expect(ran.stdout).not.toContain("conflicts with main");
    // As #80's real run hit: a PR that conflicts with main gets no CI at all.
    const conflicting = await awaitCiRun(
      "c".repeat(40),
      { pollMs: 5, startMs: 20, limitMs: 10_000 },
      true,
    );
    expect(conflicting.stdout).toContain(
      "GitHub runs no pull_request workflow on a PR that can't merge: merge main in",
    );
  });
});

/** The machine's list, under the test's XDG_CONFIG_HOME, and the clone's, inside .git. */
const machineList = async (text: string) => {
  await mkdir(join(base, "config", "monkeyshape"), { recursive: true });
  await writeFile(join(base, "config", "monkeyshape", "denylist"), text);
};
const cloneList = async (text: string) => {
  await mkdir(join(repo, ".git", "monkeyshape"), { recursive: true });
  await writeFile(join(repo, ".git", "monkeyshape", "denylist"), text);
};

const commitFile = async (path: string, text: string, message: string) => {
  await mkdir(join(wt(), path, ".."), { recursive: true });
  await writeFile(join(wt(), path), text);
  sh(wt(), "add", ".");
  sh(wt(), "commit", "-qm", message);
};

// The plan's denylist table, row by row, with invented terms.
describe("track pr: the denylist", () => {
  /** Refused before anything was pushed or posted, saying `where`. */
  const refusedNaming = async (result: ReturnType<typeof mshape>, where: string) => {
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "a denylisted term would leave the machine, so nothing was pushed or posted",
    );
    expect(result.stderr).toContain(where);
    expect(result.stderr).not.toContain("running the gate");
    expect(remoteHas()).toBe(false);
    expect(await Bun.file(`${gh}/pr.json`).exists()).toBe(false);
  };

  test("no denylist file anywhere: passes, noting none is configured", async () => {
    await writeFile(`${wt()}/body.md`, body("zorblax"));
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain("note: no denylist is configured");
    expect(opened.stderr).toContain(join(base, "config", "monkeyshape", "denylist"));
  });

  test("a term in the PR body: refused, naming its line and column", async () => {
    await machineList("# invented\nzorblax\n");
    await writeFile(`${wt()}/body.md`, body("Asked for by zorblax."));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      'the PR body, line 3, column 14: "zorblax"',
    );
  });

  test("a term in the PR title: refused", async () => {
    await machineList("zorblax\n");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "Zorblax support", "--body-file", "body.md"),
      'the PR title, line 1, column 1: "zorblax"',
    );
  });

  test("a term only in a commit message being pushed: refused, naming the commit", async () => {
    await machineList("zorblax\n");
    await commitFile("ok.md", "ok\n", "Fix what zorblax hit");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      `the message of commit ${sha}, line 1, column 10: "zorblax"`,
    );
  });

  test("a term on a line this push adds: refused, naming the file and line", async () => {
    await machineList("zorblax\n");
    await commitFile("notes/a.md", "one\ntwo zorblax\n", "notes");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      `notes/a.md:2:5, added by commit ${sha}: "zorblax"`,
    );
  });

  test("a term in a file path this push adds, an empty file's too: refused, naming the path", async () => {
    await machineList("zorblax\n");
    await commitFile("for-zorblax/empty.md", "", "an empty file");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      "the path for-zorblax/empty.md, added by commit",
    );
  });

  test("paths git C-quotes are read, contents and names both (#73's review)", async () => {
    await machineList("zorblax\n");
    await mkdir(join(wt(), "q"));
    await writeFile(join(wt(), "q", 'notes "v2".md'), "for zorblax\n");
    await writeFile(join(wt(), "q", "a\\b.txt"), "zorblax\n");
    await writeFile(join(wt(), "q", "tab\there.md"), "x zorblax\n");
    await writeFile(join(wt(), "q", 'zorblax".txt'), "");
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "odd names");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    await writeFile(`${wt()}/body.md`, body("x"));
    const refused = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    await refusedNaming(refused, `q/notes "v2".md:1:5, added by commit ${sha}`);
    expect(refused.stderr).toContain(`q/a\\b.txt:1:1, added by commit ${sha}`);
    expect(refused.stderr).toContain(`q/tab\there.md:1:3, added by commit ${sha}`);
    expect(refused.stderr).toContain(`the path q/zorblax".txt, added by commit ${sha}, column 3`);
  });

  test("a file git calls binary (a NUL byte) is scanned as text", async () => {
    await machineList("zorblax\n");
    await commitFile("data.bin", "\u0000\u0001 zorblax\n", "data");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      "data.bin:1:4, added by commit",
    );
  });

  test("a commit only another remote has is still sent, so still scanned (#73's review)", async () => {
    await machineList("zorblax\n");
    await commitFile("wip.md", "zorblax\n", "wip");
    sh(base, "init", "-q", "--bare", "-b", "main", "mirror.git");
    sh(wt(), "remote", "add", "mirror", join(base, "mirror.git"));
    sh(wt(), "push", "-q", "mirror", "HEAD:refs/heads/wip");
    sh(wt(), "fetch", "-q", "mirror");
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      "wip.md:1:1, added by commit",
    );
  });

  test("a term differing in case matches", async () => {
    await machineList("ZORBLAX\n");
    await writeFile(`${wt()}/body.md`, body("zorblax"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      'the PR body, line 3, column 1: "ZORBLAX"',
    );
  });

  test("both lists exist: both apply", async () => {
    await machineList("zorblax\n");
    await cloneList("quuxcorp\n");
    await writeFile(`${wt()}/body.md`, body("For Quuxcorp."));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "t", "--body-file", "body.md"),
      'the PR body, line 3, column 5: "quuxcorp"',
    );
    await writeFile(`${wt()}/body.md`, body("x"));
    await refusedNaming(
      mshape(wt(), "pr", "--title", "zorblax", "--body-file", "body.md"),
      'the PR title, line 1, column 1: "zorblax"',
    );
  });

  test("a term already on the remote, and the first push's main commits: not scanned", async () => {
    // main's own commit, on the remote, holds the term; so does the branch's pushed commit.
    await writeFile(`${wt()}/body.md`, body("x"));
    await commitFile("old.md", "zorblax, before it was listed\n", "zorblax notes");
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    await machineList("zorblax\n");
    await commitFile("new.md", "clean\n", "more");
    const updated = mshape(wt(), "pr");
    expect(updated.stderr).not.toContain("denylisted");
    expect(updated.code).toBe(0);
  });

  test("the branch merged main since its last push: main's commits aren't scanned, the merge's own changes are", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").code).toBe(0);
    // main moves on, with the term in a line and a path, and is pushed.
    await writeFile(join(repo, "zorblax.md"), "zorblax\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "zorblax on main");
    sh(repo, "push", "-q", "origin", "main");
    await machineList("zorblax\n");
    sh(wt(), "merge", "-q", "--no-edit", "main");
    const merged = mshape(wt(), "pr");
    expect(merged.stderr).not.toContain("denylisted");
    expect(merged.code).toBe(0);

    // An evil merge: the merge commit adds a line of its own.
    await writeFile(join(repo, "later.md"), "later\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-qm", "later on main");
    sh(repo, "push", "-q", "origin", "main");
    sh(wt(), "merge", "-q", "--no-commit", "main");
    await writeFile(`${wt()}/page.md`, "page\nzorblax in the merge\n");
    sh(wt(), "add", ".");
    sh(wt(), "commit", "-qm", "Merge main");
    const sha = sh(wt(), "rev-parse", "HEAD").slice(0, 12);
    const evil = mshape(wt(), "pr");
    expect(evil.code).toBe(1);
    expect(evil.stderr).toContain(`page.md:2:1, added by commit ${sha}: "zorblax"`);
    expect(evil.stderr).not.toContain("later.md");
    expect(evil.stderr).not.toContain("zorblax.md");
  });
});

describe("pr.yml", () => {
  test("a born repo's copy is this repo's, except that it reads bun's version from package.json", async () => {
    const root = join(import.meta.dir, "..", "..");
    const here = await Bun.file(join(root, ".github/workflows/pr.yml")).text();
    const born = await Bun.file(join(root, "template/.github/workflows/pr.yml")).text();
    expect(born).toBe(here.replace(/bun-version: .+/, "bun-version-file: package.json"));
    expect(here).toContain("bun run --silent mshape track pr --check-body");
    expect(here).toContain("if: startsWith(github.head_ref, 'track/')");
  });
});
