/**
 * `mshape init` cases that each create a repo of their own from one pack, so they run
 * concurrently; init.test.ts holds the cases that read its one shared repo.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SHARE_BEADS } from "../../src/core/scaffold.ts";
import { HAS_BD, initFromSource, pack, ROOT, run, unexpectedNotes } from "./harness.ts";

let work = "";
let tarball = "";

const fromSource = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  initFromSource(work, args, env);

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
  // A space in the path, as in init.test.ts.
  work = await mkdtemp(join(tmpdir(), "mshape init own "));
  tarball = await pack(work);
}, 120_000);

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("mshape init, a repo per case", () => {
  test.concurrent("dep bump on a born repo: a wrong digest changes nothing, the right one moves it", async () => {
    await fromSource(["bumped", "--from", tarball]);
    const repo = join(work, "bumped");
    const bin = join(repo, "node_modules", ".bin", "mshape");
    // A second release on disk: the same package under another name, so the path moves.
    const next = join(work, "monkeyshape-next.tgz");
    await writeFile(next, await Bun.file(tarball).bytes());
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(next).bytes())
      .digest("hex");
    const before = await Bun.file(join(repo, "shape.toml")).text();

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
    expect(await Bun.file(join(repo, "shape.toml")).text()).toBe(before);
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
    expect(await Bun.file(join(repo, "shape.toml")).text()).toContain(
      '"vendor/monkeyshape-next.tgz"',
    );
    expect(await Bun.file(join(repo, "bun.lock")).text()).toContain("monkeyshape-next.tgz");
    expect(await Bun.file(join(repo, "vendor", tarball.split("/").at(-1) ?? "")).exists()).toBe(
      false,
    );
  }, 180_000);

  test.concurrent("--from vendors any file it names, whatever its extension", async () => {
    const renamed = tarball.replace(/\.tgz$/, ".tar.gz");
    await Bun.write(renamed, Bun.file(tarball));
    const made = await fromSource(["named", "--from", renamed]);
    expect(unexpectedNotes(made.output)).toEqual([]);
    const pkg = await Bun.file(join(work, "named", "package.json")).json();
    expect(pkg.devDependencies.monkeyshape).toBe(`file:./vendor/${renamed.split("/").at(-1)}`);
  }, 120_000);

  test.concurrent.skipIf(!HAS_BD)(
    "a fresh clone has no beads database: check passes with a note whose fix works there",
    async () => {
      // A born repo of its own: this test pushes it, shares its beads and writes beads in it.
      await fromSource(["origin", "--from", tarball]);
      const origin = join(work, "origin");
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

  test.concurrent("without bd on PATH, init still succeeds and says how to finish", async () => {
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

  test.concurrent("from a checkout that isn't the release, init vendors a pack of it, and its gate passes", async () => {
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
    expect(check.output).toContain("mshape gate passed");
    expect(check.code).toBe(0);
  }, 120_000);
});
