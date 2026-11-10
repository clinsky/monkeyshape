/**
 * `mshape init` for real: pack this package, create a repo that installs the tarball, and run
 * the new repo's own gate. A second repo is created by the installed binary, so a template
 * file missing from package.json `files` fails here, not in an adopter's terminal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_BEADS } from "../../src/core/scaffold.ts";
import { HAS_BD, initFromSource, pack, ROOT, run, unexpectedNotes } from "./harness.ts";

let work = "";
let tarball = "";

const fromSource = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  initFromSource(work, args, env);

const tracked = async (repo: string) =>
  (await run(repo, ["git", "ls-files"])).output.trim().split("\n").sort();

let created = { code: 0, output: "" };

/**
 * A git checkout of this working tree one commit past its release tag, `v<version>`, so it is
 * not the release whatever this repo's HEAD is. It shares this repo's installed dependencies.
 */
const pastReleaseCheckout = async (dir: string): Promise<string> => {
  const listed = await run(ROOT, [
    "git",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  for (const file of listed.output.split("\0").filter((f) => f !== ""))
    if (await Bun.file(join(ROOT, file)).exists())
      await Bun.write(join(dir, file), Bun.file(join(ROOT, file)));
  await symlink(join(ROOT, "node_modules"), join(dir, "node_modules"));
  const { version } = await Bun.file(join(ROOT, "package.json")).json();
  for (const step of [
    ["git", "init", "--quiet"],
    ["git", "add", "--all"],
    ["git", "commit", "--quiet", "--no-verify", "--message", "the release"],
    ["git", "tag", `v${version}`],
    ["git", "commit", "--quiet", "--no-verify", "--allow-empty", "--message", "past it"],
  ]) {
    const done = await run(dir, step);
    if (done.code !== 0) throw new Error(`${step.join(" ")}: ${done.output}`);
  }
  return dir;
};

beforeAll(async () => {
  // A space in the path: the installed binary must find its template through it.
  work = await mkdtemp(join(tmpdir(), "mshape init "));
  tarball = await pack(work);
  created = await fromSource(["demo", "--from", tarball]);
}, 120_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("mshape init", () => {
  test("creates, installs and commits the repo, then prints the next step", () => {
    expect(created.output).toContain("Created demo/");
    expect(created.output).toContain("bun install");
    expect(created.output).toContain("first commit");
    expect(unexpectedNotes(created.output)).toEqual([]);
    expect(created.output).toContain("run /roadmap");
    expect(created.output).toContain("docs/workflow.md");
    expect(created.code).toBe(0);
  });

  test("a --from tarball is vendored: package.json and bun.lock name no path on this machine", async () => {
    const repo = join(work, "demo");
    const pkg = await Bun.file(join(repo, "package.json")).json();
    const name = tarball.split("/").at(-1) ?? "";
    expect(pkg.devDependencies.monkeyshape).toBe(`file:./vendor/${name}`);
    expect(await tracked(repo)).toContain(`vendor/${name}`);
    for (const file of ["package.json", "bun.lock"])
      expect(await Bun.file(join(repo, file)).text()).not.toContain(work);
    expect(created.output).toContain(`note: monkeyshape is installed from vendor/${name}`);
  });

  test("a --from tarball is recorded with its digest, and the files check verifies it", async () => {
    const repo = join(work, "demo");
    const name = tarball.split("/").at(-1) ?? "";
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(tarball).bytes())
      .digest("hex");
    const config = await Bun.file(join(repo, "shape.config.ts")).text();
    // Laid out by the born repo's own biome, so field by field.
    expect(config).toContain(`path: "vendor/${name}"`);
    expect(config).toContain(`package: "monkeyshape"`);
    expect(config).toContain(`sha256: "${digest}"`);
    const bin = join(repo, "node_modules", ".bin", "mshape");
    const files = await run(repo, [process.execPath, bin, "check", "--only", "files"]);
    expect(files.output).toMatch(/files +passed .*1 vendored artifact/);
    expect(files.code).toBe(0);
    // A record that isn't the tarball's digest fails, so the record is checked, not trusted.
    // Outside the repo, as `--config` is used to try a config: it must still resolve monkeyshape.
    const tampered = join(work, "tampered.config.ts");
    await writeFile(tampered, config.replace(digest, "0".repeat(64)));
    const wrong = await run(repo, [
      process.execPath,
      bin,
      "check",
      "--only",
      "files",
      "--config",
      tampered,
    ]);
    await rm(tampered);
    expect(wrong.output).toContain("files/vendored-digest");
    expect(wrong.code).toBe(1);
  }, 60_000);

  test("dep bump on a born repo: a wrong digest changes nothing, the right one moves it", async () => {
    await fromSource(["bumped", "--from", tarball]);
    const repo = join(work, "bumped");
    const bin = join(repo, "node_modules", ".bin", "mshape");
    // A second release on disk: the same package under another name, so the path moves.
    const next = join(work, "monkeyshape-next.tgz");
    await writeFile(next, await Bun.file(tarball).bytes());
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(next).bytes())
      .digest("hex");
    const before = await Bun.file(join(repo, "shape.config.ts")).text();

    const wrong = await run(repo, [
      process.execPath,
      bin,
      "dep",
      "bump",
      "monkeyshape",
      next,
      "--sha256",
      "0".repeat(64),
    ]);
    expect(wrong.output).toContain("not that release");
    expect(wrong.code).toBe(1);
    expect(await Bun.file(join(repo, "shape.config.ts")).text()).toBe(before);
    expect((await run(repo, ["git", "status", "--porcelain"])).output.trim()).toBe("");

    const right = await run(repo, [
      process.execPath,
      bin,
      "dep",
      "bump",
      "monkeyshape",
      next,
      "--sha256",
      digest,
    ]);
    expect(right.output).toContain("gate passed");
    expect(right.code).toBe(0);
    const pkg = await Bun.file(join(repo, "package.json")).json();
    expect(pkg.devDependencies.monkeyshape).toBe("file:./vendor/monkeyshape-next.tgz");
    expect(await Bun.file(join(repo, "shape.config.ts")).text()).toContain(
      '"vendor/monkeyshape-next.tgz"',
    );
    expect(await Bun.file(join(repo, "bun.lock")).text()).toContain("monkeyshape-next.tgz");
    expect(await Bun.file(join(repo, "vendor", tarball.split("/").at(-1) ?? "")).exists()).toBe(
      false,
    );
  }, 180_000);

  test("its .gitignore ignores the files the files check calls secrets, and only those", async () => {
    const repo = join(work, "demo");
    const ignored = async (path: string) =>
      (await run(repo, ["git", "check-ignore", "--quiet", path])).code === 0;
    for (const path of [".env", ".env.local", ".env.production"])
      expect({ path, ignored: await ignored(path) }).toEqual({ path, ignored: true });
    for (const path of [
      ".env.example",
      ".env.local.example",
      ".env.sample",
      ".env.template",
      ".envrc",
    ])
      expect({ path, ignored: await ignored(path) }).toEqual({ path, ignored: false });
  });

  test("--from vendors any file it names, whatever its extension", async () => {
    const renamed = tarball.replace(/\.tgz$/, ".tar.gz");
    await Bun.write(renamed, Bun.file(tarball));
    const made = await fromSource(["named", "--from", renamed]);
    expect(unexpectedNotes(made.output)).toEqual([]);
    const pkg = await Bun.file(join(work, "named", "package.json")).json();
    expect(pkg.devDependencies.monkeyshape).toBe(`file:./vendor/${renamed.split("/").at(-1)}`);
  }, 120_000);

  test("node_modules is ignored even as a symlink, the way agents share an install", async () => {
    const repo = join(work, "demo");
    // The born repo's .gitignore, and this repo's own.
    for (const [index, source] of [join(repo, ".gitignore"), join(ROOT, ".gitignore")].entries()) {
      const scratch = join(work, `scratch-${index}`);
      await mkdir(scratch, { recursive: true });
      await run(scratch, ["git", "init", "--quiet"]);
      await Bun.write(join(scratch, ".gitignore"), await Bun.file(source).text());
      await symlink(join(repo, "node_modules"), join(scratch, "node_modules"));
      expect((await run(scratch, ["git", "check-ignore", "node_modules"])).code).toBe(0);
      expect((await run(scratch, ["git", "status", "--porcelain"])).output).not.toContain(
        "node_modules",
      );
    }
  });

  test("the new repo is one clean commit, lockfile included", async () => {
    const repo = join(work, "demo");
    expect((await run(repo, ["git", "status", "--porcelain"])).output).toBe("");
    expect((await run(repo, ["git", "rev-list", "--count", "HEAD"])).output.trim()).toBe("1");
    expect((await run(repo, ["git", "branch", "--show-current"])).output.trim()).toBe("main");
    const files = await tracked(repo);
    for (const file of ["bun.lock", ".gitignore", "CLAUDE.md", "plan/.gitkeep", "notes/.gitkeep"])
      expect(files).toContain(file);
    expect(await Bun.file(join(repo, "CLAUDE.md")).text()).toBe("@AGENTS.md\n");
  });

  test("commits .claude/skills as a relative symlink to .agents/skills (D-skills-link)", async () => {
    const repo = join(work, "demo");
    const entry = (await run(repo, ["git", "ls-files", "--stage", ".claude/skills"])).output;
    expect(entry).toStartWith("120000 ");
    const blob = entry.split(/\s+/)[1] ?? "";
    expect((await run(repo, ["git", "cat-file", "-p", blob])).output).toBe("../.agents/skills");
    expect(await realpath(join(repo, ".claude", "skills"))).toBe(
      await realpath(join(repo, ".agents", "skills")),
    );
  });

  test("mshape check reads the link from disk: an absolute one fails the skills check", async () => {
    const repo = join(work, "demo");
    const link = join(repo, ".claude", "skills");
    const mshape = [process.execPath, join(repo, "node_modules", ".bin", "mshape")];
    await rm(link);
    await symlink(join(await realpath(repo), ".agents", "skills"), link);
    let result = { code: 0, output: "" };
    try {
      result = await run(repo, [...mshape, "check", "--only", "skills"]);
    } finally {
      await rm(link);
      await symlink("../.agents/skills", link);
    }
    expect(result.output).toContain("skills/link");
    expect(result.output).toContain("absolute path");
    expect(result.code).toBe(1);
    expect((await run(repo, [...mshape, "check", "--only", "skills"])).code).toBe(0);
  });

  test("check and sync agree on an ignored settings.json: both name the real fix", async () => {
    const repo = join(work, "demo");
    const mshape = [process.execPath, join(repo, "node_modules", ".bin", "mshape")];
    const exclude = join(repo, ".git", "info", "exclude");
    const before = await Bun.file(exclude).text();
    let check = { code: 0, output: "" };
    let sync = { code: 0, output: "" };
    try {
      await Bun.write(exclude, `${before}\n.claude/\n`);
      await run(repo, ["git", "rm", "--quiet", "--cached", ".claude/settings.json"]);
      check = await run(repo, [...mshape, "check", "--only", "sync"]);
      sync = await run(repo, [...mshape, "sync"]);
    } finally {
      await Bun.write(exclude, before);
      await run(repo, ["git", "add", ".claude/settings.json"]);
    }
    expect(check.code).toBe(1);
    expect(check.output).toContain("sync/ignored");
    expect(check.output).not.toContain("sync/hook-missing");
    expect(sync.code).toBe(1);
    expect(sync.output).toContain("git check-ignore -v .claude/settings.json");
    expect((await run(repo, [...mshape, "check", "--only", "sync"])).code).toBe(0);
    expect((await run(repo, [...mshape, "sync"])).code).toBe(0);
  });

  test("the handoffs store is under .git, behind relative, ignored links", async () => {
    const repo = join(work, "demo");
    const store = join(await realpath(repo), ".git", "monkeyshape", "handoffs");
    expect(await readdir(store)).toEqual([]);
    for (const link of [".handoffs", ".agents/handoffs"]) {
      expect(await readlink(join(repo, link))).not.toStartWith("/");
      expect(await realpath(join(repo, link))).toBe(store);
      expect((await run(repo, ["git", "check-ignore", link])).code).toBe(0);
    }
    expect((await run(repo, ["git", "check-ignore", ".agents/worktrees/x"])).code).toBe(0);
  });

  test.skipIf(!HAS_BD)(
    "beads is ready, its files are in the one commit, prime is capped",
    async () => {
      const repo = join(work, "demo");
      expect((await run(repo, ["bd", "ready"])).code).toBe(0);
      expect((await run(repo, ["bd", "config", "get", "prime.max-memories"])).output.trim()).toBe(
        "12",
      );
      expect(
        (await run(repo, ["bd", "config", "get", "prime.max-memory-chars"])).output.trim(),
      ).toBe("6144");
      expect(await tracked(repo)).toContain(".beads/config.yaml");
      expect(await Bun.file(join(repo, "AGENTS.md")).text()).not.toContain("BEGIN BEADS");
      expect((await run(repo, ["bd", "config", "get", "agent.profile"])).output.trim()).toBe(
        "team-maintainer",
      );
    },
  );

  test.skipIf(!HAS_BD)(
    "a fresh clone has no beads database: check passes with a note whose fix works there",
    async () => {
      const origin = join(work, "demo");
      // A bead in the origin, which a clone can't see until the beads are pushed.
      const made = await run(origin, ["bd", "create", "--title", "seen only here", "--json"]);
      expect(made.code).toBe(0);
      const remote = join(work, "remote.git");
      await run(work, ["git", "init", "--quiet", "--bare", "--initial-branch=main", remote]);
      await run(origin, ["git", "remote", "add", "origin", remote]);
      await run(origin, ["git", "push", "--quiet", "origin", "main"]);

      /** A clone of `remote` sharing the origin's install, as agents do. */
      const cloneOf = async (name: string) => {
        const clone = join(work, name);
        await run(work, ["git", "clone", "--quiet", remote, clone]);
        await symlink(join(origin, "node_modules"), join(clone, "node_modules"));
        return clone;
      };
      const note = async (clone: string) => {
        const mshape = [process.execPath, join(clone, "node_modules", ".bin", "mshape")];
        const checked = await run(clone, [...mshape, "check", "--only", "budgets"]);
        expect(checked.code).toBe(0);
        expect(checked.output).not.toContain("prerequisites/beads-failed");
        return checked.output;
      };
      const pushed = (clone: string) =>
        run(clone, ["git", "ls-remote", "origin", "refs/dolt/data"]).then((r) => r.output.trim());
      const sees = (clone: string) =>
        run(clone, ["bd", "list"]).then((r) => r.output.includes("seen only here"));
      const ifPushed = "If `git ls-remote origin refs/dolt/data` prints a line";

      // Nothing pushed: the note's test says don't bootstrap, and bootstrap would hide the bead.
      const before = await cloneOf("clone-before");
      expect(await note(before)).toContain(ifPushed);
      expect(await pushed(before)).toBe("");
      expect((await run(before, ["bd", "bootstrap", "--yes"])).code).toBe(0);
      expect(await sees(before)).toBe(false);

      // Pushed by hand, its config change not committed: the clone's note tests origin and
      // says bootstrap, and that recovers the bead.
      expect((await run(origin, ["bd", "dolt", "push", "--yes"])).code).toBe(0);
      const pushedOnly = await cloneOf("clone-pushed");
      expect(await note(pushedOnly)).toContain(ifPushed);
      expect(await pushed(pushedOnly)).not.toBe("");
      expect((await run(pushedOnly, ["bd", "bootstrap", "--yes"])).code).toBe(0);
      expect(await sees(pushedOnly)).toBe(true);

      // Shared as init's next steps say, by that exact command: its config (sync.remote,
      // dolt.auto-push) is committed and pushed, so a clone's note names bootstrap and the
      // remote outright, bootstrap recovers the bead, and the clone pushes its own writes.
      expect((await run(origin, ["sh", "-c", SHARE_BEADS])).code).toBe(0);
      expect((await run(origin, ["git", "status", "--porcelain"])).output).toBe("");
      const shared = await cloneOf("clone-shared");
      // The note tests sync.remote before naming bootstrap; its test, run here, prints a line.
      const sharedNote = await note(shared);
      const test =
        /If `(git ls-remote [^`]+ refs\/dolt\/data)` prints a line, the beads were pushed/.exec(
          sharedNote,
        )?.[1];
      expect(test).toBeDefined();
      expect((await run(shared, ["sh", "-c", test ?? "false"])).output.trim()).not.toBe("");
      expect((await run(shared, ["bd", "bootstrap", "--yes"])).code).toBe(0);
      expect(await sees(shared)).toBe(true);
      const tip = await pushed(shared);
      expect((await run(shared, ["bd", "create", "--title", "made in the clone"])).code).toBe(0);
      expect(await pushed(shared)).not.toBe(tip);

      // Both write while auto-push is throttled in the origin (it just pushed), so the two
      // diverge; PRIME.md's `bd sync`, run in each, brings both to both beads.
      expect((await run(origin, ["bd", "create", "--title", "held back in the origin"])).code).toBe(
        0,
      );
      const titles = (clone: string) => run(clone, ["bd", "list"]).then((r) => r.output);
      expect(await titles(shared)).not.toContain("held back in the origin");
      for (const clone of [origin, shared]) expect((await run(clone, ["bd", "sync"])).code).toBe(0);
      for (const clone of [origin, shared]) {
        expect(await titles(clone)).toContain("held back in the origin");
        expect(await titles(clone)).toContain("made in the clone");
      }
    },
    120_000,
  );

  test.skipIf(!HAS_BD)(
    "bd prime prints the shipped PRIME.md first, as the SessionStart hook does",
    async () => {
      const repo = join(work, "demo");
      const shipped = await Bun.file(join(ROOT, "template", ".beads", "PRIME.md")).text();
      expect(await tracked(repo)).toContain(".beads/PRIME.md");
      expect((await run(repo, ["bd", "prime"])).output).toStartWith(shipped.trim());
    },
  );

  test("without bd on PATH, init still succeeds and says how to finish", async () => {
    // A PATH with bun and git but no bd, as on a CI runner.
    const path = await mkdtemp(join(tmpdir(), "mshape-path-"));
    await symlink(process.execPath, join(path, "bun"));
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(path, "git"));
    const result = await fromSource(["no-beads", "--from", tarball], { PATH: path });
    await rm(path, { recursive: true, force: true });
    expect(result.output).toContain("note: bd is not on PATH");
    expect(result.output).toContain("bd init --skip-agents --non-interactive");
    expect(result.output).toContain("first commit");
    expect(result.code).toBe(0);
    expect(await Bun.file(join(work, "no-beads", ".beads", "config.yaml")).exists()).toBe(false);
  });

  test("its gate passes with its one starter test, and nothing skipped or in error", async () => {
    const check = await run(join(work, "demo"), [process.execPath, "run", "check"]);
    expect(check.output).toContain("mshape check passed");
    expect(check.output).not.toContain("note:");
    // A first run that says "error:" teaches a new user to ignore the gate.
    expect(check.output).not.toContain("error:");
    expect(check.output).toContain(" 1 pass");
    expect(check.code).toBe(0);
  }, 60_000);

  test("from a checkout that isn't the release, init vendors a pack of it, and its gate passes", async () => {
    // Built here, not read from this repo's HEAD, which sits on a release tag right after one.
    const checkout = await pastReleaseCheckout(join(work, "checkout"));
    // No --from: npm's package of this version isn't this checkout's code.
    const born = await run(work, [
      process.execPath,
      join(checkout, "src", "cli", "main.ts"),
      "init",
      "from-checkout",
    ]);
    expect(born.code).toBe(0);
    expect(unexpectedNotes(born.output)).toEqual([]);
    const repo = join(work, "from-checkout");
    const spec = (await Bun.file(join(repo, "package.json")).json()).devDependencies.monkeyshape;
    expect(spec).toMatch(/^file:\.\/vendor\/monkeyshape-\d+\.\d+\.\d+-dev\.[0-9a-f]{7}/);
    const check = await run(repo, [process.execPath, "run", "check"]);
    expect(check.output).toContain("mshape check passed");
    expect(check.code).toBe(0);
  }, 120_000);

  test("the installed package carries the template: its init makes the same repo", async () => {
    const bin = join(work, "demo", "node_modules", ".bin", "mshape");
    const again = await run(work, [process.execPath, bin, "init", "--from", tarball, "again"]);
    expect(again.code).toBe(0);
    expect(unexpectedNotes(again.output)).toEqual([]);
    expect(await tracked(join(work, "again"))).toEqual(await tracked(join(work, "demo")));
  }, 60_000);

  test("refuses a name that is not lowercase words joined by hyphens", async () => {
    const result = await fromSource(["My_App"]);
    expect(result.output).toContain("lowercase words joined by hyphens");
    expect(result.code).toBe(2);
  });

  test("refuses --from without a value rather than installing from the registry", async () => {
    for (const args of [
      ["no-value", "--from"],
      ["--from", "--other", "no-value"],
    ]) {
      const result = await fromSource(args);
      expect(result.output).toContain("--from needs a value");
      expect(result.code).toBe(2);
    }
    expect(await Bun.file(join(work, "no-value", "package.json")).exists()).toBe(false);
  });

  test("refuses a directory that is not empty, and leaves it alone", async () => {
    await mkdir(join(work, "taken"));
    await writeFile(join(work, "taken", "keep.txt"), "mine\n");
    const result = await fromSource(["taken"]);
    expect(result.output).toContain("not empty");
    expect(result.code).toBe(2);
    expect(await readdir(join(work, "taken"))).toEqual(["keep.txt"]);
  });
});
