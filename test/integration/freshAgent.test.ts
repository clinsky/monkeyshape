/**
 * The fresh-agent test: what an agent loads at session start, in this repo, in one `init` just
 * made, and in one adopted by following docs/adopting.md, states the loop's conventions and
 * doesn't contradict them. It runs the real
 * SessionStart hooks, so it needs bd; CI installs a pinned one, and fails rather than skips
 * without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import { CONVENTIONS, missingConventions, sessionContext } from "./freshAgent.ts";
import { adoptingFiles, HAS_BD, initFromSource, pack, ROOT, run } from "./harness.ts";

let work = "";
/** The adopted repo's session context before step 6's `sync`, and after it. */
let beforeSync = "";

/**
 * An existing repo adopted by following docs/adopting.md in its order: the pinned install from
 * a tarball and the `mshape` script (step 1), the guide's own file blocks (steps 3, 4 and 6),
 * beads by `bd init --skip-agents`, and `sync`. Like a real adopter, it already ran bd's bare
 * `bd prime` hook, which sync must keep working.
 */
const adopt = async (repo: string) => {
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await Bun.write(join(repo, path), text);
  };
  const tarball = await pack(work);
  await mkdir(join(repo, "vendor"), { recursive: true });
  await copyFile(tarball, join(repo, "vendor", basename(tarball)));
  const dev = pkg.devDependencies;
  await write(
    "package.json",
    `${JSON.stringify({
      name: "adopted",
      private: true,
      type: "module",
      scripts: { mshape: "mshape" },
      devDependencies: {
        monkeyshape: `./vendor/${basename(tarball)}`,
        effect: dev.effect,
        "@biomejs/biome": dev["@biomejs/biome"],
        typescript: dev.typescript,
        "@types/bun": dev["@types/bun"],
      },
    })}\n`,
  );
  for (const [path, text] of Object.entries(await adoptingFiles())) await write(path, text);
  await write(".gitignore", "node_modules/\n");
  await write("src/core/greet.ts", "export const greet = (name: string): string => name;\n");
  await write(
    ".claude/settings.json",
    `${JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] },
        ],
      },
    })}\n`,
  );
  for (const command of [
    ["git", "init", "--quiet"],
    ["bd", "init", "--skip-agents", "--non-interactive", "--quiet", "--prefix", "adopted"],
    [process.execPath, "install"],
  ]) {
    const ran = await run(repo, command);
    if (ran.code !== 0) throw new Error(`${command.join(" ")}: ${ran.output}`);
  }
  beforeSync = await sessionContext(repo);
  const synced = await run(repo, [process.execPath, "node_modules/.bin/mshape", "sync"]);
  if (synced.code !== 0) throw new Error(`mshape sync: ${synced.output}`);
};

beforeAll(async () => {
  if (!HAS_BD) return;
  work = await mkdtemp(join(tmpdir(), "mshape fresh "));
  await initFromSource(work, ["born"]);
  await adopt(join(work, "adopted"));
}, 180_000);

afterAll(async () => {
  if (work !== "") await rm(work, { recursive: true, force: true });
});

describe("a fresh agent", () => {
  test("CI has bd, so this test runs there", () => {
    const { CI } = process.env;
    if (CI !== undefined) expect(HAS_BD).toBe(true);
  });

  test.skipIf(!HAS_BD)(
    "in this repo, is told every convention at session start",
    async () => {
      expect(missingConventions(await sessionContext(ROOT))).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!HAS_BD)(
    "in a repo init just made, is told every convention",
    async () => {
      expect(missingConventions(await sessionContext(join(work, "born")))).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!HAS_BD)(
    "in a repo adopted by following docs/adopting.md, is told every convention",
    async () => {
      expect(missingConventions(await sessionContext(join(work, "adopted")))).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!HAS_BD)(
    "the adopted repo before its sync isn't told them: the test can fail",
    () => {
      // Before step 6 only bd's own hook runs, so the conventions come from sync, not luck.
      expect(missingConventions(beforeSync).length).toBeGreaterThan(0);
    },
  );

  test("each convention is told apart: bd's default text alone states none and contradicts one", () => {
    const bdDefault =
      "Agents may commit. This is an ephemeral branch (no upstream). Do not push it unless the user says to. Use bd ready.";
    expect(missingConventions(bdDefault)).toEqual([
      ...CONVENTIONS.map((c) => `doesn't state ${c.what}`),
      'says "Do not push"',
    ]);
  });
});
