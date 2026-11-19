/**
 * `mshape track pr` and the plan's File owners table: the "Other tracks' files" line, the
 * owners it mails, and the squash onto a moved main it refuses (`jhz.4`). Each case is a row
 * of plan/MILESTONE.md's Owners notice table.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { body, mshape, pr, repo, sh, useTrackPrRepo, wt } from "./trackPrHarness.ts";

useTrackPrRepo();

const PLAN = `# Milestone

### File owners

| Path | Track |
|---|---|
| \`notes/**\` | other |
| \`third/**\` | third |
| \`ops/**\` | gone |
| \`page.md\` | docs |
| not a row |
`;

/** Commits `files` on main, pushes it, and has the track's worktree fetch it. */
const onMain = async (files: Record<string, string>) => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(`${repo}/${path.split("/").slice(0, -1).join("/") || "."}`, { recursive: true });
    await writeFile(`${repo}/${path}`, text);
  }
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "on main");
  sh(repo, "push", "-q", "origin", "main");
};

const commit = async (files: Record<string, string>, message = "work") => {
  for (const [path, text] of Object.entries(files)) {
    await mkdir(`${wt()}/${path.split("/").slice(0, -1).join("/") || "."}`, { recursive: true });
    await writeFile(`${wt()}/${path}`, text);
  }
  sh(wt(), "add", ".");
  sh(wt(), "commit", "-qm", message);
};

/** The unread messages in `track`'s mailbox, by subject. */
const mail = async (track: string) => {
  const dir = `${repo}/.git/monkeyshape/mail/${track}`;
  const files = (await readdir(dir).catch(() => [] as Array<string>)).filter((file) =>
    file.endsWith(".json"),
  );
  return Promise.all(
    files.map(async (file) => JSON.parse(await Bun.file(`${dir}/${file}`).text()).subject),
  );
};

const open = async () => {
  await writeFile(`${wt()}/body.md`, body("Why."));
  return mshape(wt(), "pr", "--title", "t", "--body-file", "body.md");
};

describe("track pr: the owners notice", () => {
  test("only its own files (and a path no row matches): no line, no mail", async () => {
    await onMain({ "plan/MILESTONE.md": PLAN });
    mshape(repo, "new", "other");
    await commit({ "page.md": "mine\n", "free.md": "no one's\n" });
    const opened = await open();
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain(
      "note: plan/MILESTONE.md's File owners table: skipped `| not a row |`",
    );
    expect((await pr()).body).not.toContain("Other tracks' files");
    expect(await mail("other")).toEqual([]);
  });

  test("another track's file: named in the Gate section, its owner mailed once; the same set again mails no one", async () => {
    await onMain({ "plan/MILESTONE.md": PLAN });
    mshape(repo, "new", "other");
    await commit({ "notes/a.md": "edited by docs\n" });
    const opened = await open();
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain("Sent ");
    expect((await pr()).body).toContain("`notes/a.md` (other)");
    expect(await mail("other")).toEqual(["#7 from docs edits your files: `notes/a.md`"]);

    await commit({ "notes/a.md": "edited again\n", "page.md": "more\n" });
    expect(mshape(wt(), "pr").code).toBe(0);
    expect(await mail("other")).toHaveLength(1);
  });

  test("a later push adds a third track's file: that track only is mailed; an owner with no mailbox is only named", async () => {
    await onMain({ "plan/MILESTONE.md": PLAN });
    mshape(repo, "new", "other");
    mshape(repo, "new", "third");
    await commit({ "notes/a.md": "x\n" });
    expect((await open()).code).toBe(0);
    await commit({ "third/b.md": "y\n", "ops/c.md": "z\n" });
    const pushed = mshape(wt(), "pr");
    expect(pushed.code).toBe(0);
    expect(await mail("other")).toHaveLength(1);
    expect(await mail("third")).toEqual(["#7 from docs edits your files: `third/b.md`"]);
    expect(await mail("gone")).toEqual([]);
    expect(pushed.stderr).toContain("note: gone owns ops/c.md but wasn't mailed");
    const named = (await pr()).body;
    expect(named).toContain("`ops/c.md` (gone)");
    expect(named).toContain("`third/b.md` (third)");
  });

  test("no plan on main: no line, no mail, one note", async () => {
    await commit({ "notes/a.md": "x\n" });
    const opened = await open();
    expect(opened.code).toBe(0);
    expect(opened.stderr).toContain(
      "note: no plan/MILESTONE.md on `origin/main`, so no file here is another track's",
    );
    expect((await pr()).body).not.toContain("Other tracks' files");
  });
});

describe("track pr: a squash onto a moved main (jhz.4)", () => {
  /** The track's work forked from main; then another track's amendment lands on main. */
  const setup = async () => {
    await onMain({ "plan/MILESTONE.md": PLAN, "notes/a.md": "one\n" });
    sh(wt(), "merge", "-q", "origin/main");
    await commit({ "page.md": "first\n" });
    await commit({ "page.md": "second\n" });
    await onMain({ "notes/a.md": "one\nanother track's amendment\n" });
    sh(wt(), "fetch", "-q", "origin");
  };

  test("squashed with origin/main as its parent, reverting main's new line in another track's file: refused, naming it", async () => {
    await setup();
    sh(wt(), "reset", "--soft", "origin/main");
    sh(wt(), "commit", "-qm", "squashed");
    const refused = await open();
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("notes/a.md (lines 2 at");
    expect(refused.stderr).toContain("Nothing was pushed or posted");
    expect(await Bun.file(`${repo}/../gh/pr.json`).exists()).toBe(false);
  });

  test("main merged in, then the line removed on purpose in a commit of its own: pushed", async () => {
    await setup();
    sh(wt(), "merge", "-q", "origin/main");
    await commit({ "notes/a.md": "one\n" }, "drop the amendment, on purpose");
    expect((await open()).code).toBe(0);
  });

  test("the squash rebuilt on the old merge base, then main merged in: pushed", async () => {
    await setup();
    sh(wt(), "reset", "--soft", sh(wt(), "merge-base", "HEAD", "origin/main"));
    sh(wt(), "commit", "-qm", "squashed");
    sh(wt(), "merge", "-q", "origin/main");
    expect((await open()).code).toBe(0);
  });

  test("once the PR's head holds the rewrite, a removal on top is the track's call: pushed", async () => {
    await setup();
    sh(wt(), "reset", "--soft", sh(wt(), "merge-base", "HEAD", "origin/main"));
    sh(wt(), "commit", "-qm", "squashed");
    sh(wt(), "merge", "-q", "origin/main");
    expect((await open()).code).toBe(0);
    await commit({ "notes/a.md": "one\n" }, "drop the amendment, on purpose");
    expect(mshape(wt(), "pr").code).toBe(0);
  });
});
