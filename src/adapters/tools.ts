/**
 * Fetching the tools `mshape` pins (`src/core/tools.ts`) into the machine's cache. A tool's
 * directory exists only once its download matched the pin and was unpacked, since it is
 * written beside and renamed into place: a cached copy runs with no network.
 */
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import {
  hashMismatch,
  type Platform,
  platformOf,
  type ToolPin,
  toolDir,
  unsupportedPlatform,
} from "../core/tools.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { runTool } from "./process.ts";

/** A tool ready to run, or why it can't: for the caller's integration outcome. */
export type ToolOutcome =
  | { readonly state: "ok"; readonly path: string }
  | { readonly state: "unavailable"; readonly reason: string };

const ok = (path: string): ToolOutcome => ({ state: "ok", path });
const unavailable = (reason: string): ToolOutcome => ({ state: "unavailable", reason });

/** The way out of a cache that can't be written. */
const WRITABLE =
  "set XDG_CACHE_HOME to a writable directory, where mshape caches the tools it fetches";

/** A write into the cache: a failure is typed, so `fetchTool` can say what to do about it. */
const write = <A>(dir: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceError({ operation: "write", path: dir, reason: String(cause) }),
  });

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

type Download =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | { readonly ok: false; readonly reason: string };

const download = async (url: string): Promise<Download> => {
  try {
    const response = await fetch(url);
    if (!response.ok) return { ok: false, reason: `${response.status} ${response.statusText}` };
    return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) };
  } catch (cause) {
    return { ok: false, reason: String(cause) };
  }
};

/**
 * `pin`'s executable for `platform`, from `cache`: the cached copy, else downloaded, checked
 * against the pin's sha256 and unpacked. Never fails: a tool that can't be had is
 * `unavailable` with the reason (offline, a hash mismatch, an unsupported platform, a cache
 * it can't write), and a
 * download that doesn't match is deleted, never unpacked or run.
 */
export const fetchTool = (cache: string, pin: ToolPin, platform: Platform) =>
  Effect.gen(function* () {
    const dir = toolDir(cache, pin);
    const path = join(dir, pin.executable);
    if (yield* Effect.promise(() => exists(path))) return ok(path);
    const { url, sha256 } = pin.downloads[platform];
    const got = yield* Effect.promise(() => download(url));
    if (!got.ok)
      return unavailable(
        `${pin.name} ${pin.version} is not in the cache and its download failed (${got.reason}): connect and rerun, so mshape can fetch ${url}`,
      );
    const digest = new Bun.CryptoHasher("sha256").update(got.bytes).digest("hex");
    if (digest !== sha256) return unavailable(hashMismatch(pin, url, sha256, digest));
    const partial = yield* write(dir, async () => {
      await mkdir(dirname(dir), { recursive: true });
      return mkdtemp(`${dir}.partial-`);
    });
    return yield* Effect.gen(function* () {
      const tarball = join(partial, "download.tgz");
      const unpacked = join(partial, "tool");
      yield* write(dir, async () => {
        await Bun.write(tarball, got.bytes);
        await mkdir(unpacked);
      });
      const untar = yield* runTool(unpacked, ["tar", "xzf", tarball]);
      const executable = join(unpacked, pin.executable);
      if (untar.code !== 0 || !(yield* Effect.promise(() => exists(executable))))
        return unavailable(
          `${pin.name} ${pin.version}'s download matched its pin but didn't unpack to ${pin.executable}: ${untar.stderr.trim() || "no such file"}`,
        );
      yield* write(dir, async () => {
        await chmod(executable, 0o755);
        // Another mshape may have finished first: its copy is the same verified files.
        await rename(unpacked, dir).catch(() => undefined);
      });
      return (yield* Effect.promise(() => exists(path)))
        ? ok(path)
        : unavailable(`${pin.name} ${pin.version} could not be written to ${dir}: ${WRITABLE}`);
    }).pipe(
      Effect.ensuring(
        Effect.promise(() => rm(partial, { recursive: true, force: true }).catch(() => undefined)),
      ),
    );
  }).pipe(
    // A cache it can't write is a tool it can't have, never a crash.
    Effect.catchTag("WorkspaceError", (error) =>
      Effect.succeed(
        unavailable(
          `${pin.name} ${pin.version} could not be written to ${error.path} (${error.reason}): ${WRITABLE}`,
        ),
      ),
    ),
  );

/** `fetchTool` for the machine `os`-`arch` (`process.platform`, `process.arch`). */
export const toolFor = (cache: string, pin: ToolPin, os: string, arch: string) => {
  const platform = platformOf(os, arch);
  return platform === undefined
    ? Effect.succeed(unavailable(unsupportedPlatform(os, arch)))
    : fetchTool(cache, pin, platform);
};
