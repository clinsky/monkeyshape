/**
 * The compiled `mshape`, built from this checkout for this machine and run where there is no
 * Bun: no `bun` on the PATH and an empty cache. The other platforms' binaries are built and
 * run by CI's `binary` jobs.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { compileBinaries, packSource } from "../../src/adapters/release.ts";
import { BINARY_TARGETS, packVersion, RELEASE_DIR } from "../../src/core/release.ts";
import { skipWithout } from "../support.ts";
import { ROOT } from "./harness.ts";

const host = BINARY_TARGETS.find(
  (target) => target.platform === `${process.platform}-${process.arch}`,
);

let work = "";
let binary = "";
let sums = "";
let version = "";
let out = "";

/** The binary with a PATH holding neither Bun nor this checkout's tools, unless `path` adds one. */
const run = (cwd: string, args: ReadonlyArray<string>, path: ReadonlyArray<string> = []) => {
  const ran = Bun.spawnSync([binary, ...args], {
    cwd,
    env: {
      PATH: [...path, "/usr/bin", "/bin"].join(":"),
      HOME: join(work, "home"),
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
      // This repo pins `dev`, its own source: what is tested here is the binary itself, run as
      // the launcher runs the version it launched.
      MSHAPE_LAUNCHED: version,
    },
  });
  return { code: ran.exitCode, out: `${ran.stdout}${ran.stderr}` };
};

beforeAll(async () => {
  if (host === undefined) return;
  work = await mkdtemp(join(tmpdir(), "mshape-binary-"));
  version = packVersion(await Effect.runPromise(packSource(ROOT)));
  // Where `release pack` writes by default: the gate's check below runs over it.
  out = join(ROOT, RELEASE_DIR, `test-${process.pid}`);
  const written = await Effect.runPromise(compileBinaries(ROOT, out, version, [host]));
  binary = written[0] ?? "";
  sums = await Bun.file(written.at(-1) ?? "").text();
}, 120_000);

afterAll(async () => {
  if (work !== "") await rm(work, { recursive: true, force: true });
  if (out !== "") await rm(out, { recursive: true, force: true });
});

describe.skipIf(host === undefined)("the compiled mshape, with no Bun", () => {
  test("prints the pack's version and its help", () => {
    expect(run(work, ["--version"])).toEqual({ code: 0, out: `${version}\n` });
    const help = run(work, ["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain(`mshape ${version}`);
  });

  test("SHA256SUMS lists the binary and install.sh by their hashes", async () => {
    const digest = async (path: string) =>
      new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
    expect(sums).toBe(
      `${await digest(join(ROOT, "install.sh"))}  install.sh\n${await digest(binary)}  mshape-${host?.platform}\n`,
    );
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

  test("runs a TypeScript repo's tsc and biome with the Bun on the PATH, not itself", () => {
    const checked = run(ROOT, ["check", "--only", "coverage"], [dirname(process.execPath)]);
    expect(checked.out).toMatch(/\bcoverage +passed\b/);
    expect(checked.code).toBe(0);
  });

  test("with no Bun on the PATH or in ~/.bun, a TypeScript repo's tools fail, naming both", () => {
    const checked = run(ROOT, ["check", "--only", "coverage"]);
    expect(checked.out).toContain(
      "coverage needs tsc, but bun is not on PATH or at ~/.bun/bin/bun. Install Bun (https://bun.sh)",
    );
    // Installing typescript wouldn't help: Bun is what's missing.
    expect(checked.out).not.toContain("bun add -d");
    expect(checked.code).not.toBe(0);
  });

  test("binaries where pack writes by default leave this repo's gate green: none over the cap or uncovered", () => {
    const checked = Bun.spawnSync(
      [process.execPath, join(ROOT, "src/cli/main.ts"), "check", "--only", "files,coverage"],
      { cwd: ROOT, env: { ...process.env, CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "" } },
    );
    expect(`${checked.stdout}${checked.stderr}`).toContain("mshape check passed");
    expect(checked.exitCode).toBe(0);
  });

  // The Python pack's template (8il.17): born by the compiled mshape and gated by it, with no
  // Bun on the PATH. uv, git and Python come from the machine; uv's cache is the machine's, so
  // the pinned toolchain isn't fetched again.
  test.skipIf(skipWithout(Bun.which("uv") !== null))(
    "init --pack python, then its gate: green with no Bun on the PATH",
    () => {
      const uv = dirname(Bun.which("uv") ?? "");
      const env = {
        PATH: [uv, "/usr/bin", "/bin"].join(":"),
        HOME: join(work, "home"),
        UV_CACHE_DIR:
          process.env["UV_CACHE_DIR"] ?? join(process.env["HOME"] ?? "", ".cache", "uv"),
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_PID: "",
      };
      const spawn = (cwd: string, args: ReadonlyArray<string>) => {
        const ran = Bun.spawnSync([binary, ...args], { cwd, env });
        return { code: ran.exitCode, out: `${ran.stdout}${ran.stderr}` };
      };
      const born = spawn(work, ["init", "py-born", "--pack", "python"]);
      expect(born.out).toContain("Created py-born/");
      expect(born.out).toContain("base configs: .mshape/ruff.toml, pyproject.toml");
      const gate = spawn(join(work, "py-born"), ["gate"]);
      for (const stage of ["ruff-format", "ruff", "ty", "pytest"])
        expect(gate.out).toMatch(new RegExp(`\\b${stage} +passed\\b`));
      expect(gate.out).toContain("mshape gate passed");
      expect(gate.code).toBe(0);
      expect(gate.out).not.toContain("bun is not on PATH");
    },
    300_000,
  );

  test("a cache it can't write fails, saying to set XDG_CACHE_HOME", () => {
    const ran = Bun.spawnSync([binary, "--version"], {
      cwd: work,
      env: { PATH: "/usr/bin:/bin", HOME: "/proc", CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "" },
    });
    expect(`${ran.stdout}${ran.stderr}`).toContain("set XDG_CACHE_HOME to a writable directory");
    expect(ran.exitCode).toBe(1);
  });
});
