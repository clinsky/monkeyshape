import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
let base = "";
let repo = "";

/**
 * A fake `gh api`: a POST (`--input`) appends the file to posted.log and prints a URL, unless
 * `fail` exists, when it fails, having posted anyway if `fail` says "after". A GET lists the
 * posted reviews' bodies.
 */
const FAKE_GH = `
const args = process.argv.slice(2);
const dir = process.env.FAKE_GH;
const log = Bun.file(dir + "/posted.log");
const posted = (await log.exists()) ? await log.text() : "";
const input = args[args.indexOf("--input") + 1];
const fail = Bun.file(dir + "/fail");
if (args.includes("--input")) {
  const review = await Bun.file(input).text();
  if (await fail.exists()) {
    if ((await fail.text()) === "after") await Bun.write(log, posted + review + "\\n");
    console.error("HTTP 502");
    process.exit(1);
  }
  await Bun.write(log, posted + review + "\\n");
  console.log("https://example.test/pr/3#review-1");
} else {
  for (const line of posted.split("\\n").filter(Boolean)) console.log(JSON.parse(line).body);
}
`;

const mshape = (stdin: string | undefined, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: `${join(base, "bin")}:/usr/bin:/bin`,
      FAKE_GH: base,
      XDG_CONFIG_HOME: join(base, "config"),
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
    },
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
};

const machineList = async (text: string) => {
  await mkdir(join(base, "config", "monkeyshape"), { recursive: true });
  await writeFile(join(base, "config", "monkeyshape", "denylist"), text);
};

const posted = async () => {
  const log = Bun.file(join(base, "posted.log"));
  return (await log.exists()) ? await log.text() : "";
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-denylist-")));
  repo = join(base, "repo");
  await mkdir(repo);
  await mkdir(join(base, "bin"));
  await writeFile(join(base, "gh.js"), FAKE_GH);
  await writeFile(
    join(base, "bin", "gh"),
    `#!/bin/sh\nexec "${process.execPath}" "${base}/gh.js" "$@"\n`,
  );
  await chmod(join(base, "bin", "gh"), 0o755);
  Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repo });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("mshape scan", () => {
  test("no denylist: exit 0 with a note naming both places", () => {
    const scanned = mshape("zorblax", "scan", "-");
    expect(scanned.code).toBe(0);
    expect(scanned.stdout).toContain("note: no denylist is configured");
    expect(scanned.stdout).toContain(join(repo, ".git", "monkeyshape", "denylist"));
  });

  test("a term: exit 1, printing the line, column and term", async () => {
    await machineList("zorblax\n");
    await writeFile(join(repo, "draft.md"), "fine\nfor ZORBLAX\n");
    const scanned = mshape(undefined, "scan", "draft.md");
    expect(scanned.code).toBe(1);
    expect(scanned.stderr).toBe('draft.md, line 2, column 5: "zorblax"');
    expect(mshape("clean", "scan", "-")).toEqual({
      code: 0,
      stdout: "stdin: no denylisted term",
      stderr: "",
    });
  });

  test("the clone's list, inside .git, applies on its own", async () => {
    await mkdir(join(repo, ".git", "monkeyshape"));
    await writeFile(join(repo, ".git", "monkeyshape", "denylist"), "quuxcorp\n");
    expect(mshape("a quuxcorp b", "scan", "-").code).toBe(1);
  });

  test("a term with regex characters matches literally", async () => {
    await machineList("a.b\n");
    expect(mshape("axb", "scan", "-").code).toBe(0);
    expect(mshape("a.b", "scan", "-").code).toBe(1);
  });
});

describe("mshape review post", () => {
  const review = (body: string, comment: string) =>
    JSON.stringify({
      commit_id: "abc",
      event: "COMMENT",
      body,
      comments: [{ path: "src/a.ts", line: 3, side: "RIGHT", body: comment }],
    });

  test("a term in the review's body or a comment: refused, naming where; nothing posted", async () => {
    await machineList("zorblax\n");
    await writeFile(join(repo, "review.json"), review("**Fit**\nas zorblax does", "fine"));
    const inBody = mshape(undefined, "review", "post", "3", "review.json");
    expect(inBody.code).toBe(1);
    expect(inBody.stderr).toContain("so nothing was posted");
    expect(inBody.stderr).toContain('body, line 2, column 4: "zorblax"');
    // A review has no commits to rewrite: no advice about them.
    expect(inBody.stderr).not.toContain("git commit --amend");
    await writeFile(join(repo, "review.json"), review("Fit", "unlike Zorblax"));
    expect(mshape(undefined, "review", "post", "3", "review.json").stderr).toContain(
      'comments[0].body, line 1, column 8: "zorblax"',
    );
    expect(await posted()).toBe("");
  });

  test("a clean review is posted once, and its URL printed", async () => {
    await machineList("zorblax\n");
    await writeFile(join(repo, "review.json"), review("Fit: fine", "a nit"));
    const ok = mshape(undefined, "review", "post", "3", "review.json");
    expect(ok.code).toBe(0);
    expect(ok.stdout).toBe("posted https://example.test/pr/3#review-1");
    expect((await posted()).split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("with no denylist, it posts with the note", async () => {
    await writeFile(join(repo, "review.json"), review("Fit", "x"));
    const ok = mshape(undefined, "review", "post", "3", "review.json");
    expect(ok.code).toBe(0);
    expect(ok.stderr).toContain("note: no denylist is configured");
  });

  test("a failed post says whether GitHub has the review anyway", async () => {
    await writeFile(join(repo, "review.json"), review("Fit: one", "x"));
    await writeFile(join(base, "fail"), "after");
    expect(mshape(undefined, "review", "post", "3", "review.json").stderr).toContain(
      "HTTP 502. A review with this body's first line is on the PR now: it was posted; don't post again.",
    );
    await rm(join(base, "posted.log"));
    await writeFile(join(base, "fail"), "before");
    expect(mshape(undefined, "review", "post", "3", "review.json").stderr).toContain(
      "No review with this body's first line is on the PR",
    );
  });

  test("not a review, or not a PR number: refused, nothing posted", async () => {
    await writeFile(join(repo, "review.md"), "just text");
    expect(mshape(undefined, "review", "post", "3", "review.md").stderr).toContain(
      "review.md is not a review",
    );
    expect(mshape(undefined, "review", "post", "x", "review.md").stderr).toContain(
      "give the pull request's number",
    );
    expect(await posted()).toBe("");
  });
});
