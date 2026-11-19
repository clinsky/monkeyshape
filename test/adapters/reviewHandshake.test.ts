/**
 * The review side of the plan's Review handshake table, against real git, the CLI and a fake
 * gh: `review post` mails the track (and removes the worktree at LGTM), a track's PR from
 * another branch keeps `review-<track>` (`3lo`), and a main checkout whose config doesn't
 * load still gets its review (`zw9`). `track pr`'s side is in trackPr.test.ts.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    env: {
      ...process.env,
      PATH: `${join(base, "bin")}:/usr/bin:/bin`,
      FAKE_GH: join(base, "gh"),
      XDG_CONFIG_HOME: join(base, "config"),
      CLAUDE_CONFIG_DIR: join(base, "no-claude"),
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

/** `pulls/<n>` answers from $FAKE_GH/pr-<n>.json; posting a review prints its URL. */
const FAKE_GH = `
const args = process.argv.slice(2);
const dir = process.env.FAKE_GH;
const path = args[1] ?? "";
const pulls = /pulls\\/(\\d+)$/.exec(path);
if (args[0] === "api" && pulls) {
  const file = Bun.file(dir + "/pr-" + pulls[1] + ".json");
  if (!(await file.exists())) { console.error("HTTP 404"); process.exit(1); }
  console.log(await file.text());
} else if (args[0] === "api" && /pulls\\/\\d+\\/reviews$/.test(path) && args.includes("--input")) {
  console.log("https://example.test/pr/" + path.split("/").at(-2) + "#review-1");
} else { console.error("fake gh: unmodelled " + args.join(" ")); process.exit(1); }
`;

const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

const reviewPath = (pr: number) => `${repo}/.agents/worktrees/repo.pr-${pr}`;
const trackPath = () => `${repo}/.agents/worktrees/repo@docs`;

const mail = async (address: string) => {
  const dir = join(repo, ".git", "monkeyshape", "mail", address);
  const files = (await readdir(dir).catch(() => [] as Array<string>)).filter((file) =>
    file.endsWith(".json"),
  );
  return Promise.all(
    files.map(async (file) => JSON.parse(await readFile(join(dir, file), "utf8"))),
  );
};

/** The docs track publishes a commit on `branch` as pull request `pr`. */
const publishFromTrack = async (pr: number, branch: string) => {
  if (branch !== "track/docs") sh(trackPath(), "switch", "-q", "-c", branch);
  await writeFile(join(trackPath(), `pr${pr}.md`), "x\n");
  sh(trackPath(), "add", ".");
  sh(trackPath(), "commit", "-qm", `pr ${pr}`);
  sh(trackPath(), "push", "-q", "origin", `HEAD:refs/heads/${branch}`, `HEAD:refs/pull/${pr}/head`);
  await writeFile(
    join(base, "gh", `pr-${pr}.json`),
    JSON.stringify(JSON.stringify({ ref: branch, body: "## Beads\n\n- x-1 a bead\n" })),
  );
};

/** A clone with no track publishes pull request `pr`. */
const publishFromNoTrack = async (pr: number) => {
  sh(base, "clone", "-q", join(base, "origin.git"), "author");
  const author = join(base, "author");
  await writeFile(join(author, "other.md"), "y\n");
  sh(author, "add", ".");
  sh(author, "-c", "user.name=A", "-c", "user.email=a@example.com", "commit", "-qm", "other");
  sh(author, "push", "-q", "origin", `HEAD:refs/pull/${pr}/head`);
  await writeFile(
    join(base, "gh", `pr-${pr}.json`),
    JSON.stringify(JSON.stringify({ ref: "someones-fix", body: "" })),
  );
};

const post = async (pr: number, review: object) => {
  await writeFile(join(base, "review.json"), JSON.stringify(review));
  return mshape(reviewPath(pr), "review", "post", String(pr), join(base, "review.json"));
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-handshake-")));
  await mkdir(join(base, "bin"));
  await mkdir(join(base, "gh"));
  await writeFile(join(base, "gh.js"), FAKE_GH);
  await writeFile(
    join(base, "bin", "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${base}/gh.js" "$@"\n`,
  );
  await chmod(join(base, "bin", "gh"), 0o755);
  sh(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  for (const [key, value] of [
    ["user.name", "Test"],
    ["user.email", "test@example.com"],
    ["commit.gpgsign", "false"],
  ])
    sh(repo, "config", key ?? "", value ?? "");
  sh(repo, "remote", "add", "origin", join(base, "origin.git"));
  await writeFile(join(repo, "shape.toml"), 'packs = ["typescript"]\n');
  await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.handoffs\n");
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
  sh(repo, "push", "-q", "origin", "main");
  expect(mshape(repo, "track", "new", "docs").code).toBe(0);
});

describe("review: a track's PR from another branch (3lo), and a broken config (zw9)", () => {
  test("a PR from a branch the track's worktree has checked out is the track's: review-docs", async () => {
    await publishFromTrack(9, "fix/gate");
    const opened = mshape(repo, "review", "9");
    expect(opened.code).toBe(0);
    expect(
      (await readFile(join(repo, ".git", "monkeyshape", "reviews", "pr-9.track"), "utf8")).trim(),
    ).toBe("docs");
  });

  test("a PR from no track stays review-<n>: nothing is recorded", async () => {
    await publishFromNoTrack(10);
    expect(mshape(repo, "review", "10").code).toBe(0);
    expect(await exists(join(repo, ".git", "monkeyshape", "reviews", "pr-10.track"))).toBe(false);
  });

  test("the main checkout's shape.toml doesn't load: the worktree is made, with a note", async () => {
    await publishFromNoTrack(10);
    await writeFile(join(repo, "shape.toml"), "[coverage]\n[coverage]\n");
    const opened = mshape(repo, "review", "10");
    expect(opened.code).toBe(0);
    expect(opened.stdout).toContain("note: the main checkout's config doesn't load");
    expect(await exists(reviewPath(10))).toBe(true);
  });
});

describe("review post: the handshake", () => {
  test("findings: the track is mailed the link and one line per finding with its severity; the worktree stays", async () => {
    await publishFromTrack(9, "track/docs");
    expect(mshape(repo, "review", "9").code).toBe(0);
    const posted = await post(9, {
      commit_id: "0".repeat(40),
      event: "COMMENT",
      body: "## Fit\n\nFine.",
      comments: [
        {
          path: "a.ts",
          line: 3,
          side: "RIGHT",
          body: "**Blocker: the walk goes too far.**\n\nProbe...",
        },
        { path: "b.ts", line: 9, side: "RIGHT", body: "**Nit:** a name" },
      ],
    });
    expect(posted.code).toBe(0);
    expect(posted.stdout).toContain("posted https://example.test/pr/9#review-1");
    const [message] = await mail("docs");
    expect(message.subject).toBe("#9 reviewed: 1 blocker, 1 nit");
    expect(message.body).toContain("Review: https://example.test/pr/9#review-1");
    expect(message.body).toContain("- blocker (a.ts:3): the walk goes too far.");
    expect(message.body).toContain("- nit (b.ts:9): a name");
    expect(await exists(reviewPath(9))).toBe(true);
  });

  test("LGTM: the track is mailed LGTM, the worktree is removed, review-docs is kept (1vc)", async () => {
    await publishFromTrack(9, "track/docs");
    expect(mshape(repo, "review", "9").code).toBe(0);
    const posted = await post(9, {
      commit_id: "0".repeat(40),
      event: "COMMENT",
      body: "LGTM: both blockers verified.",
    });
    expect(posted.code).toBe(0);
    expect(posted.stdout).toContain(`removed ${reviewPath(9)}`);
    expect(posted.stdout).toContain("kept review-docs");
    expect((await mail("docs")).map((message) => message.subject)).toEqual(["#9: LGTM"]);
    expect(await exists(reviewPath(9))).toBe(false);
  });

  test("a PR from no track: no one is mailed, and the worktree stays", async () => {
    await publishFromNoTrack(10);
    expect(mshape(repo, "review", "10").code).toBe(0);
    const posted = await post(10, { commit_id: "0".repeat(40), event: "COMMENT", body: "LGTM" });
    expect(posted.code).toBe(0);
    expect(posted.stderr).toContain("note: #10 is from no track");
    expect(await mail("docs")).toEqual([]);
    expect(await exists(reviewPath(10))).toBe(true);
  });
});
