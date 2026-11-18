import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { fetchTool, toolFor } from "../../src/adapters/tools.ts";
import { PLATFORMS, type ToolPin } from "../../src/core/tools.ts";

let work = "";
let tarball = new Uint8Array();
let served = 0;
const server = Bun.serve({
  port: 0,
  fetch: (request) => {
    served += 1;
    const path = new URL(request.url).pathname;
    if (path === "/tool.tgz") return new Response(tarball);
    if (path === "/tampered.tgz") return new Response(new Uint8Array([...tarball, 0]));
    return new Response("not found", { status: 404 });
  },
});

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A pin whose every platform downloads `file` from the test server, pinned to `digest`. */
const pin = (file: string, digest: string, version = "1.0.0"): ToolPin => ({
  name: "demo",
  version,
  executable: "package/demo",
  downloads: Object.fromEntries(
    PLATFORMS.map((platform) => [
      platform,
      { url: new URL(file, server.url).href, sha256: digest },
    ]),
  ) as ToolPin["downloads"],
});

const cacheDir = () => mkdtemp(join(work, "cache-"));

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mshape-tools-"));
  await Bun.write(join(work, "src", "package", "demo"), "#!/bin/sh\necho demo 1.0.0\n");
  const packed = Bun.spawnSync([
    "tar",
    "czf",
    join(work, "tool.tgz"),
    "-C",
    join(work, "src"),
    "package",
  ]);
  expect(packed.exitCode).toBe(0);
  tarball = await Bun.file(join(work, "tool.tgz")).bytes();
});

afterAll(async () => {
  server.stop(true);
  await rm(work, { recursive: true, force: true });
});

describe("fetchTool", () => {
  test("not cached, online: fetches, verifies, unpacks a runnable executable", async () => {
    const cache = await cacheDir();
    const got = await Effect.runPromise(
      fetchTool(cache, pin("/tool.tgz", sha256(tarball)), "linux-x64"),
    );
    expect(got).toEqual({ state: "ok", path: join(cache, "tools/demo/1.0.0/package/demo") });
    const ran = Bun.spawnSync([got.state === "ok" ? got.path : ""]);
    expect(ran.stdout.toString()).toBe("demo 1.0.0\n");
    // Nothing half-written is left beside it.
    expect(await readdir(join(cache, "tools/demo"))).toEqual(["1.0.0"]);
  });

  test("cached: runs it with no network", async () => {
    const cache = await cacheDir();
    const pinned = pin("/tool.tgz", sha256(tarball));
    await Effect.runPromise(fetchTool(cache, pinned, "linux-x64"));
    const before = served;
    const offline = { ...pinned, downloads: pin("/gone.tgz", sha256(tarball)).downloads };
    const got = await Effect.runPromise(fetchTool(cache, offline, "linux-x64"));
    expect(got.state).toBe("ok");
    expect(served).toBe(before);
  });

  test("a download that doesn't match the pin is refused, never unpacked, naming both hashes", async () => {
    const cache = await cacheDir();
    const expected = sha256(tarball);
    const got = await Effect.runPromise(
      fetchTool(cache, pin("/tampered.tgz", expected), "linux-x64"),
    );
    expect(got.state).toBe("unavailable");
    const reason = got.state === "unavailable" ? got.reason : "";
    expect(reason).toContain(new URL("/tampered.tgz", server.url).href);
    expect(reason).toContain(expected);
    expect(reason).toContain(sha256(new Uint8Array([...tarball, 0])));
    expect(reason).toContain("never run");
    // Nothing was written: not the tool, not even its directory.
    expect(await readdir(cache)).toEqual([]);
  });

  test("not cached, offline: unavailable, naming the URL to fetch", async () => {
    const cache = await cacheDir();
    const offline: ToolPin = {
      ...pin("", ""),
      downloads: Object.fromEntries(
        PLATFORMS.map((p) => [p, { url: "http://127.0.0.1:9/demo.tgz", sha256: "0" }]),
      ) as ToolPin["downloads"],
    };
    const got = await Effect.runPromise(fetchTool(cache, offline, "linux-x64"));
    expect(got.state).toBe("unavailable");
    expect(got.state === "unavailable" ? got.reason : "").toContain(
      "connect and rerun, so mshape can fetch http://127.0.0.1:9/demo.tgz",
    );
  });

  test("an unsupported platform is unavailable, naming the three supported", async () => {
    const got = await Effect.runPromise(
      toolFor(await cacheDir(), pin("/tool.tgz", ""), "win32", "x64"),
    );
    expect(got).toEqual({
      state: "unavailable",
      reason:
        "win32-x64 is not a platform mshape supports: it runs on linux-x64, linux-arm64, darwin-arm64",
    });
  });

  // Root writes anywhere: the read-only directory below wouldn't stop it.
  test.skipIf(process.getuid?.() === 0)(
    "a cache it can't write is unavailable, saying to set XDG_CACHE_HOME, not a crash",
    async () => {
      const cache = await cacheDir();
      await chmod(cache, 0o555);
      try {
        const got = await Effect.runPromise(
          fetchTool(cache, pin("/tool.tgz", sha256(tarball)), "linux-x64"),
        );
        expect(got.state).toBe("unavailable");
        expect(got.state === "unavailable" ? got.reason : "").toContain(
          "set XDG_CACHE_HOME to a writable directory",
        );
      } finally {
        await chmod(cache, 0o755);
      }
    },
  );

  test("a cache under a path that can't exist is unavailable too", async () => {
    const got = await Effect.runPromise(
      fetchTool("/proc/nope", pin("/tool.tgz", sha256(tarball)), "linux-x64"),
    );
    expect(got.state).toBe("unavailable");
    expect(got.state === "unavailable" ? got.reason : "").toContain("set XDG_CACHE_HOME");
  });
});
