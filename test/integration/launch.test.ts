/**
 * Installing and running `mshape`: the plan's table, one test per row. Two real compiled
 * versions of this checkout, 9.9.1 and 9.9.2, are served as a release would be. `install.sh`
 * installs 9.9.1, and repos pin one or the other, with the PATH a machine without Bun has.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { compileBinaries } from "../../src/adapters/release.ts";
import { BINARY_TARGETS, binaryAsset, SUMS_FILE } from "../../src/core/release.ts";
import { ROOT } from "./harness.ts";

const host = BINARY_TARGETS.find(
  (target) => target.platform === `${process.platform}-${process.arch}`,
);
const asset = host === undefined ? "" : binaryAsset(host);

let work = "";
/** Each served version's directory of assets, by version. */
const releases = new Map<string, string>();
let requests: Array<string> = [];
let tamper = false;

const server = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const path = new URL(request.url).pathname;
    requests.push(path);
    const match = /^\/(?:download\/v([^/]+)|latest\/download)\/([^/]+)$/.exec(path);
    const dir = releases.get(match?.[1] ?? "9.9.1");
    if (match === null || dir === undefined) return new Response("not found", { status: 404 });
    const bytes = await Bun.file(join(dir, match[2] ?? "")).bytes();
    // A tampered binary: one byte appended, so SHA256SUMS no longer vouches for it.
    if (!(tamper && match[2] === asset)) return new Response(bytes);
    const tampered = new Uint8Array(bytes.length + 1);
    tampered.set(bytes);
    return new Response(tampered);
  },
});
const RELEASES = server.url.href.replace(/\/$/, "");
const OFFLINE = "http://127.0.0.1:9";

const sha256 = async (path: string) =>
  new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
const sumsOf = (version: string) => sha256(join(releases.get(version) ?? "", SUMS_FILE));

const home = () => join(work, "home");
const bin = () => join(work, "bin");
const installed = () => join(bin(), "mshape");

/** A machine without Bun: system tools only, this test's home, and the served releases. */
const machine = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin:/bin",
  HOME: home(),
  MSHAPE_RELEASES_URL: RELEASES,
  CLAUDE_CODE_SESSION_ID: "",
  CLAUDE_PID: "",
  ...extra,
});

/**
 * Async, never `spawnSync`: the release server runs in this process, and a blocked event
 * loop would leave a child's download waiting on it forever.
 */
const run = async (argv: ReadonlyArray<string>, cwd: string, env: Record<string, string>) => {
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: `${stdout}${stderr}`.trim() };
};

const install = (env: Record<string, string> = {}) =>
  run(["sh", join(ROOT, "install.sh")], work, machine({ MSHAPE_INSTALL_DIR: bin(), ...env }));

/** A repo whose shape.toml pins `pin`, as TOML lines under [mshape]. */
const repo = async (name: string, pin: string) => {
  const dir = join(work, name);
  await Bun.write(join(dir, "shape.toml"), `[mshape]\n${pin}\n`);
  return dir;
};

const mshape = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  run([installed(), ...args], cwd, machine(env));

/** A PATH holding only links to `tools`, for a machine that lacks the rest. */
const onlyTools = async (name: string, tools: ReadonlyArray<string>) => {
  const dir = join(work, name);
  await mkdir(dir, { recursive: true });
  for (const tool of tools) {
    const path = Bun.which(tool);
    if (path !== null) await symlink(path, join(dir, tool));
  }
  return dir;
};

const INSTALL_TOOLS = ["sh", "uname", "mktemp", "rm", "awk", "cut", "mkdir", "chmod", "mv", "cat"];

beforeAll(async () => {
  if (host === undefined) return;
  work = await mkdtemp(join(tmpdir(), "mshape-launch-"));
  for (const version of ["9.9.1", "9.9.2"]) {
    const dir = join(work, "releases", version);
    await Effect.runPromise(compileBinaries(ROOT, dir, version, [host]));
    releases.set(version, dir);
  }
}, 240_000);

afterAll(async () => {
  server.stop(true);
  if (work !== "") await rm(work, { recursive: true, force: true });
});

describe.skipIf(host === undefined)("install.sh", () => {
  test("the installer's download doesn't match SHA256SUMS: refuses, deletes it, installs nothing", async () => {
    tamper = true;
    try {
      const ran = await install({ MSHAPE_VERSION: "9.9.1" });
      expect(ran.code).toBe(1);
      expect(ran.out).toContain(`${asset} has sha256`);
      expect(ran.out).toContain("deleted, nothing installed");
      expect(await Bun.file(installed()).exists()).toBe(false);
    } finally {
      tamper = false;
    }
  });

  test("an unsupported platform: refuses, naming it and the three supported", async () => {
    const fake = join(work, "fake-uname");
    await Bun.write(
      join(fake, "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo FreeBSD ;; *) echo amd64 ;; esac\n',
    );
    await chmod(join(fake, "uname"), 0o755);
    const ran = await install({ PATH: `${fake}:/usr/bin:/bin` });
    expect(ran.out).toContain(
      "FreeBSD-amd64 is not a platform mshape supports: it runs on linux-x64, linux-arm64, darwin-arm64",
    );
    expect(ran.code).toBe(1);
  });

  test("neither curl nor wget, or no sha tool: refuses, naming what's missing", async () => {
    const noFetch = await onlyTools("no-fetch", [...INSTALL_TOOLS, "sha256sum", "shasum"]);
    const fetchless = await install({ PATH: noFetch });
    expect(fetchless.out).toContain("neither curl nor wget is installed");
    expect(fetchless.code).toBe(1);
    const noSha = await onlyTools("no-sha", [...INSTALL_TOOLS, "curl", "wget"]);
    const shaless = await install({ PATH: noSha });
    expect(shaless.out).toContain("neither sha256sum nor shasum is installed");
    expect(shaless.code).toBe(1);
    expect(await Bun.file(installed()).exists()).toBe(false);
  });

  test("on a supported machine: installs, verified; prints the version and the PATH line", async () => {
    const ran = await install();
    expect(ran.out).toContain(
      `installed mshape 9.9.1 at ${installed()} (verified against SHA256SUMS)`,
    );
    expect(ran.out).toContain(`${bin()} is not on your PATH; add it`);
    expect(ran.code).toBe(0);
    // The latest release, when no version is asked for.
    expect(requests).toContain(`/latest/download/${asset}`);
    expect((await Bun.file(`${installed()}.sums`).text()).trim()).toBe(await sumsOf("9.9.1"));
  });
});

describe.skipIf(host === undefined)("the installed mshape, as launcher", () => {
  test("outside any repo: runs itself", async () => {
    expect(await mshape(work, ["--version"])).toEqual({ code: 0, out: "9.9.1" });
  });

  test("the pin equals the installed version: runs itself, no network", async () => {
    const dir = await repo("same", `version = "9.9.1"\nsums = "${await sumsOf("9.9.1")}"`);
    requests = [];
    expect(await mshape(dir, ["--version"], { MSHAPE_RELEASES_URL: OFFLINE })).toEqual({
      code: 0,
      out: "9.9.1",
    });
    expect(requests).toEqual([]);
  });

  test("the pin equals the installed version with other sums: refuses, naming both", async () => {
    const other = "a".repeat(64);
    const dir = await repo("same-other-sums", `version = "9.9.1"\nsums = "${other}"`);
    const ran = await mshape(dir, ["--version"]);
    expect(ran.out).toContain(`SHA256SUMS sha256 ${other}`);
    expect(ran.out).toContain(`installed from SHA256SUMS sha256 ${await sumsOf("9.9.1")}`);
    expect(ran.code).toBe(1);
  });

  test("another pinned version, not cached, offline: exit 1 with a note naming the URL", async () => {
    const dir = await repo("offline", `version = "9.9.2"\nsums = "${await sumsOf("9.9.2")}"`);
    const ran = await mshape(dir, ["--version"], { MSHAPE_RELEASES_URL: OFFLINE });
    expect(ran.out).toContain(`fetching ${OFFLINE}/download/v9.9.2/SHA256SUMS failed`);
    expect(ran.code).toBe(1);
  });

  test("a hash mismatch against the pin: refuses, names the file and both hashes, never runs it", async () => {
    const pinned = "b".repeat(64);
    const dir = await repo("mismatch", `version = "9.9.2"\nsums = "${pinned}"`);
    const ran = await mshape(dir, ["--version"]);
    expect(ran.out).toContain(
      `${RELEASES}/download/v9.9.2/SHA256SUMS has sha256 ${await sumsOf("9.9.2")}, but shape.toml pins sums ${pinned}`,
    );
    expect(ran.code).toBe(1);
    expect(await Bun.file(join(home(), ".cache/monkeyshape/9.9.2/mshape")).exists()).toBe(false);
  });

  test("a download SHA256SUMS doesn't vouch for: refused and deleted, never run", async () => {
    const dir = await repo("tampered", `version = "9.9.2"\nsums = "${await sumsOf("9.9.2")}"`);
    tamper = true;
    try {
      const ran = await mshape(dir, ["--version"]);
      expect(ran.out).toContain("refused and deleted, never run");
      expect(ran.code).toBe(1);
      const cached = await readdir(join(home(), ".cache/monkeyshape/9.9.2")).catch(() => []);
      expect(cached.filter((file) => file.startsWith("mshape"))).toEqual([]);
    } finally {
      tamper = false;
    }
  });

  test("another pinned version, not cached, online: fetches, verifies, caches, execs", async () => {
    const dir = await repo("other", `version = "9.9.2"\nsums = "${await sumsOf("9.9.2")}"`);
    requests = [];
    expect(await mshape(dir, ["--version"])).toEqual({ code: 0, out: "9.9.2" });
    expect(requests).toEqual(["/download/v9.9.2/SHA256SUMS", `/download/v9.9.2/${asset}`]);
    const cached = join(home(), ".cache/monkeyshape/9.9.2/mshape");
    expect(await sha256(cached)).toBe(await sha256(join(releases.get("9.9.2") ?? "", asset)));
  });

  test("another pinned version, cached and verified: execs it, no network", async () => {
    const dir = await repo("other", `version = "9.9.2"\nsums = "${await sumsOf("9.9.2")}"`);
    requests = [];
    expect(await mshape(dir, ["--version"], { MSHAPE_RELEASES_URL: OFFLINE })).toEqual({
      code: 0,
      out: "9.9.2",
    });
    expect(requests).toEqual([]);
  });

  test("a track worktree, or any directory in the repo: the same pin, the same cache", async () => {
    const dir = await repo("other", `version = "9.9.2"\nsums = "${await sumsOf("9.9.2")}"`);
    const deep = join(dir, ".agents", "worktrees", "repo@a", "src");
    await mkdir(deep, { recursive: true });
    expect(await mshape(deep, ["--version"], { MSHAPE_RELEASES_URL: OFFLINE })).toEqual({
      code: 0,
      out: "9.9.2",
    });
  });

  test("dev set (this repo): runs dev's argv with the command's arguments, no fetch", async () => {
    const dir = await repo("dev", `version = "0.0.0"\ndev = ["sh", "-c", "echo dev: $*", "dev"]`);
    requests = [];
    expect(await mshape(dir, ["check", "--only", "refs"])).toEqual({
      code: 0,
      out: "dev: check --only refs",
    });
    expect(requests).toEqual([]);
  });

  test("dev runs bun, and there is none: says where it looked and what to install", async () => {
    const dir = await repo("dev-bun", `version = "0.0.0"\ndev = ["bun", "src/cli/main.ts"]`);
    const ran = await mshape(dir, ["--version"]);
    expect(ran.out).toContain("dev runs bun, but bun is not on PATH or at ~/.bun/bin/bun");
    expect(ran.code).toBe(1);
  });

  test("a launched mshape spawns mshape: the nested one follows the pin, not the installed version", async () => {
    // What a gate stage's or `track pr`'s `mshape` sees: the installed launcher, in the pinned
    // repo, with MSHAPE_LAUNCHED inherited from the 9.9.2 its parent launched.
    const dir = await repo("nested", `version = "9.9.2"\nsums = "${await sumsOf("9.9.2")}"`);
    expect(await mshape(dir, ["--version"], { MSHAPE_LAUNCHED: "9.9.2" })).toEqual({
      code: 0,
      out: "9.9.2",
    });
    // The pinned copy itself, with its own name in the variable: runs itself, no network.
    requests = [];
    const cached = join(home(), ".cache/monkeyshape/9.9.2/mshape");
    expect(
      await run(
        [cached, "--version"],
        dir,
        machine({ MSHAPE_LAUNCHED: "9.9.2", MSHAPE_RELEASES_URL: OFFLINE }),
      ),
    ).toEqual({ code: 0, out: "9.9.2" });
    expect(requests).toEqual([]);
  });

  test("a dev argv spawns mshape: the nested one runs dev again", async () => {
    const dir = await repo(
      "nested-dev",
      `version = "0.0.0"\ndev = ["sh", "-c", "echo dev: $*", "dev"]`,
    );
    expect(await mshape(dir, ["--version"], { MSHAPE_LAUNCHED: "dev" })).toEqual({
      code: 0,
      out: "dev: --version",
    });
  });

  test("a pinned version with no release there: says so, not to reconnect", async () => {
    const dir = await repo("unreleased", `version = "9.9.7"\nsums = "${"c".repeat(64)}"`);
    const ran = await mshape(dir, ["--version"]);
    expect(ran.out).toContain(`but ${RELEASES} has no release v9.9.7`);
    expect(ran.out).toContain("check the pin's version, or MSHAPE_RELEASES_URL");
    expect(ran.out).not.toContain("connect and rerun");
    expect(ran.code).toBe(1);
  });

  test("a pin of another version with no sums: refuses, saying what to add", async () => {
    const dir = await repo("no-sums", `version = "9.9.2"`);
    const ran = await mshape(dir, ["--version"]);
    expect(ran.out).toContain("pins mshape 9.9.2 with no sums");
    expect(ran.code).toBe(1);
  });
});
