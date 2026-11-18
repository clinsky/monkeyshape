/**
 * The compiled `mshape`, built from this checkout for this machine and run where there is no
 * Bun: no `bun` on the PATH and an empty cache. The other platforms' binaries are built and
 * run by CI's `binary` jobs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { compileBinaries, packSource } from "../../src/adapters/release.ts";
import { BINARY_TARGETS, packVersion } from "../../src/core/release.ts";
import { ROOT } from "./harness.ts";

const host = BINARY_TARGETS.find(
  (target) => target.platform === `${process.platform}-${process.arch}`,
);

let work = "";
let binary = "";
let sums = "";
let version = "";

/** The binary with a PATH holding neither Bun nor this checkout's tools. */
const run = (cwd: string, args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync([binary, ...args], {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: join(work, "home"),
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
    },
  });
  return { code: ran.exitCode, out: `${ran.stdout}${ran.stderr}` };
};

beforeAll(async () => {
  if (host === undefined) return;
  work = await mkdtemp(join(tmpdir(), "mshape-binary-"));
  version = packVersion(await Effect.runPromise(packSource(ROOT)));
  const written = await Effect.runPromise(
    compileBinaries(ROOT, join(work, "out"), version, [host]),
  );
  binary = written[0] ?? "";
  sums = await Bun.file(written.at(-1) ?? "").text();
}, 120_000);

afterAll(async () => {
  if (work !== "") await rm(work, { recursive: true, force: true });
});

describe.skipIf(host === undefined)("the compiled mshape, with no Bun", () => {
  test("prints the pack's version and its help", () => {
    expect(run(work, ["--version"])).toEqual({ code: 0, out: `${version}\n` });
    const help = run(work, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain(`mshape ${version}`);
  });

  test("SHA256SUMS lists the binary by its hash", async () => {
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(binary).bytes())
      .digest("hex");
    expect(sums).toBe(`${digest}  mshape-${host?.platform}\n`);
  });

  test("names no path of the machine that built it, so a commit builds the same anywhere", async () => {
    const text = new TextDecoder("latin1").decode(await Bun.file(binary).bytes());
    expect(text).not.toContain(ROOT);
    // The bundler's comment naming each module by its path from the build's directory.
    expect(text).not.toContain("// node_modules/");
  });

  test("unpacks the files it ships into the cache once, as they are in the checkout", async () => {
    run(work, ["--version"]);
    const versions = join(work, "home", ".cache", "monkeyshape", version);
    const dirs = await readdir(versions);
    expect(dirs).toHaveLength(1);
    const unpacked = join(versions, dirs[0] ?? "");
    for (const file of [
      "template/.beads/PRIME.md",
      "skills/track/SKILL.md",
      "config/biome.base.json",
    ])
      expect(await Bun.file(join(unpacked, file)).text()).toBe(
        await Bun.file(join(ROOT, file)).text(),
      );
  });

  test("parses and walks TypeScript with oxc: the arch check over this repo", () => {
    const checked = run(ROOT, ["check", "--only", "arch"]);
    expect(checked.out).toMatch(/\barch +passed\b/);
    expect(checked.code).toBe(0);
  });
});
