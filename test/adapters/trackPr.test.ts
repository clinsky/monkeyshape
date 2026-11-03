import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prSkeleton } from "../../src/core/conventions.ts";

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

/** `mshape track ...`, with the fake gh first on PATH and no bd. */
const mshape = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, "track", ...args], {
    cwd,
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_GH: gh,
      CLAUDE_CONFIG_DIR: join(base, "no-claude"),
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
if (args[1] === "list") console.log((await state.exists()) ? "[" + (await state.text()) + "]" : "[]");
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
          "echo gate ran && echo ' 3 pass' >&2 && test ! -e red && { test ! -e late || git commit -q --allow-empty -m late-unreviewed; }",
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
    await writeFile(`${wt()}/draft.md`, "draft");
    expect(mshape(wt(), "pr", "--title", "t", "--body-file", "body.md").stderr).toContain(
      "the worktree has uncommitted changes (?? draft.md)",
    );
    await rm(`${wt()}/draft.md`);
    const missing = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(missing.stderr).toContain("the body isn't ready, so nothing was pushed or posted:");
    expect(missing.stderr).toContain("the PR body lacks `## Evidence`");

    await writeFile(`${wt()}/body.md`, body("x"));
    await writeFile(`${wt()}/red`, "");
    sh(wt(), "add", "red");
    sh(wt(), "commit", "-qm", "red");
    const red = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
    expect(red.code).toBe(1);
    expect(red.stderr).toContain("the gate failed (exit 1), so nothing was pushed or posted");
    expect(red.stderr).toContain("gate ran");
    expect(remoteHas()).toBe(false);
    expect(await Bun.file(`${gh}/pr.json`).exists()).toBe(false);
  });

  test("a commit made while the gate runs isn't pushed: the remote gets the gated commit", async () => {
    await writeFile(`${wt()}/body.md`, body("x"));
    // The probe from #35's review: the gate makes a commit, as a second session might.
    await writeFile(`${wt()}/late`, "");
    const gated = sh(wt(), "rev-parse", "HEAD");
    const opened = mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
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
    // The same test track pr runs: every section, but no bead listed.
    const noBead = check(
      body("x")
        .replace("## Not done", "## Gate\n\nran\n\n## Not done")
        .replace("- x-abc.1 the bead", "none yet"),
    );
    expect(noBead.code).toBe(1);
    expect(noBead.out).toContain("the Beads section lists no bead");
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
