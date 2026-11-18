/**
 * The running `mshape`: where its own files are. Run by Bun from a checkout or an npm install,
 * they sit beside `src/`; the compiled binary carries them inside itself and unpacks them once
 * per build into the machine's cache (`unpackedDir`), where `template/`, `skills/` and
 * `config/` are read like any package's.
 */
import { chmod, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { assetUrl, listedDigest, type Pin, unpackedDir } from "../core/launch.ts";
import { SUMS_FILE } from "../core/release.ts";
import type { Platform } from "../core/tools.ts";
import { decodeStrict } from "../helpers/decodeStrict.ts";
import { MshapePin } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";

/** The way out when the cache can't be written, for an agent with nothing else to read. */
const WRITABLE =
  "set XDG_CACHE_HOME to a writable directory, where mshape unpacks the files it carries";

/** Set by the compiled binary's entry before the CLI loads; undefined under Bun. */
let unpackedRoot: string | undefined;

/** Set first by the compiled binary's entry, before it decides what to run. */
let compiled = false;

/** Called by the compiled binary's entry before anything else. */
export const markCompiled = (): void => {
  compiled = true;
};

/** Whether this `mshape` is the compiled binary, whose `process.execPath` is itself. */
export const runningCompiled = (): boolean => compiled || unpackedRoot !== undefined;

/** The running monkeyshape's package directory: `template/`, `skills/`, `config/`. */
export const ownRoot = (): string =>
  unpackedRoot ?? fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/, "");

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * Unpacks the binary's embedded files (package path to the embedded file's path) into the
 * cache, once: a directory is complete when it exists, since it is written beside and renamed
 * into place. Then they are this `mshape`'s own files.
 */
export const unpackOwnFiles = (
  files: Readonly<Record<string, string>>,
  cache: string,
  version: string,
  digest: string,
) =>
  Effect.gen(function* () {
    const root = unpackedDir(cache, version, digest);
    const done = yield* Effect.tryPromise({
      try: async () => {
        if (await exists(root)) return true;
        await mkdir(dirname(root), { recursive: true });
        const partial = await mkdtemp(`${root}.partial-`);
        try {
          for (const [path, embedded] of Object.entries(files))
            await Bun.write(join(partial, path), Bun.file(embedded));
          // Another mshape may have finished first: its copy is the same files.
          await rename(partial, root).catch(() => undefined);
        } finally {
          await rm(partial, { recursive: true, force: true });
        }
        return exists(root);
      },
      catch: (cause) =>
        new WorkspaceError({ operation: "unpack", path: root, reason: `${cause}; ${WRITABLE}` }),
    });
    if (!done)
      return yield* Effect.fail(
        new WorkspaceError({ operation: "unpack", path: root, reason: `not written; ${WRITABLE}` }),
      );
    unpackedRoot = root;
    return root;
  });

/**
 * The pin of the repo `cwd` is in: the nearest `shape.toml` upward, and its `[mshape]`.
 * Undefined outside any repo, without a pin, or when `shape.toml` or the pin doesn't decode:
 * then this `mshape` runs itself, and `mshape check` reports the config.
 */
export const readPin = (cwd: string) =>
  Effect.gen(function* () {
    for (let dir = cwd; ; dir = dirname(dir)) {
      const file = Bun.file(join(dir, "shape.toml"));
      if (yield* Effect.promise(() => file.exists())) {
        const text = yield* Effect.promise(() => file.text());
        const parsed = yield* Effect.try(() => Bun.TOML.parse(text) as { mshape?: unknown }).pipe(
          Effect.orElseSucceed(() => ({}) as { mshape?: unknown }),
        );
        if (parsed.mshape === undefined) return undefined;
        const pin = yield* decodeStrict(MshapePin)(parsed.mshape).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        return pin === undefined ? undefined : { root: dir, pin: pin satisfies Pin };
      }
      if (dirname(dir) === dir) return undefined;
    }
  });

/** The `SHA256SUMS` digest recorded beside `binary` (`<binary>.sums`); undefined without one. */
export const recordedSums = (binary: string) =>
  Effect.promise(async () => {
    const file = Bun.file(`${binary}.sums`);
    return (await file.exists()) ? (await file.text()).trim() : undefined;
  });

/** A pinned `mshape` ready to run, or why not, as a message for the person at the prompt. */
export type Pinned =
  | { readonly state: "ok"; readonly path: string }
  | { readonly state: "refused"; readonly message: string };

const fetchBytes = (url: string) =>
  Effect.promise(async () => {
    try {
      const response = await fetch(url);
      if (!response.ok) return `${response.status} ${response.statusText}`;
      return new Uint8Array(await response.arrayBuffer());
    } catch (cause) {
      return String(cause);
    }
  });

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** Writes `bytes` to `path` beside it first, then renames it into place. */
const place = (path: string, bytes: Uint8Array | string, mode: number) =>
  Effect.tryPromise({
    try: async () => {
      const partial = `${path}.partial-${process.pid}`;
      await Bun.write(partial, bytes);
      await chmod(partial, mode);
      await rename(partial, path);
    },
    catch: (cause) =>
      new WorkspaceError({
        operation: "write",
        path,
        reason: `${cause}; set XDG_CACHE_HOME to a writable directory, where mshape caches the versions repos pin`,
      }),
  });

/**
 * `mshape` `version` for `platform`, from the cache or fetched from `releases`: its
 * `SHA256SUMS` must hash to `sums`, the pin's, and the binary to what `SHA256SUMS` lists for
 * it. A download that doesn't match is never written, so never run. The cached copy records
 * `sums` beside it, which is how it passes as the pinned version when it runs.
 */
export const pinnedBinary = (
  cache: string,
  releases: string,
  version: string,
  sums: string,
  platform: Platform,
) =>
  Effect.gen(function* () {
    const dir = join(cache, version);
    const binary = join(dir, "mshape");
    const refused = (message: string): Pinned => ({ state: "refused", message });
    if (
      (yield* Effect.promise(() => Bun.file(binary).exists())) &&
      (yield* recordedSums(binary)) === sums
    )
      return { state: "ok", path: binary } satisfies Pinned;
    const sumsUrl = assetUrl(releases, version, SUMS_FILE);
    const listing = yield* fetchBytes(sumsUrl);
    const offline = (url: string, why: string) =>
      refused(
        why.startsWith("404")
          ? // Reconnecting won't help: that version was never released there.
            `shape.toml pins mshape ${version}, but ${releases} has no release v${version} (${url}: ${why}): check the pin's version, or MSHAPE_RELEASES_URL`
          : `shape.toml pins mshape ${version}, which isn't in the cache, and fetching ${url} failed (${why}): connect and rerun`,
      );
    if (typeof listing === "string") return offline(sumsUrl, listing);
    const listed = sha256(listing);
    if (listed !== sums)
      return refused(
        `${sumsUrl} has sha256 ${listed}, but shape.toml pins sums ${sums}: refused, nothing run. If the pin is right, the download was tampered with; else fix the pin`,
      );
    const asset = `mshape-${platform}`;
    const expected = listedDigest(new TextDecoder().decode(listing), asset);
    if (expected === undefined)
      return refused(
        `${sumsUrl} lists no ${asset}: mshape ${version} has no build for ${platform}`,
      );
    const binaryUrl = assetUrl(releases, version, asset);
    const bytes = yield* fetchBytes(binaryUrl);
    if (typeof bytes === "string") return offline(binaryUrl, bytes);
    const got = sha256(bytes);
    if (got !== expected)
      return refused(
        `${binaryUrl} has sha256 ${got}, but its SHA256SUMS lists ${expected}: refused and deleted, never run. Retry; if it persists, the download was tampered with`,
      );
    return yield* Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () => mkdir(dir, { recursive: true }),
        catch: (cause) =>
          new WorkspaceError({ operation: "mkdir", path: dir, reason: String(cause) }),
      });
      // The binary, then its record: until the record names these sums, a copy at this path
      // (another build, half-written) is fetched again, never trusted.
      yield* place(binary, bytes, 0o755);
      yield* place(`${binary}.sums`, `${sums}\n`, 0o644);
      return { state: "ok", path: binary } satisfies Pinned;
    }).pipe(
      Effect.catchTag("WorkspaceError", (error) =>
        Effect.succeed(
          refused(
            `mshape ${version} could not be written to ${error.path} (${error.reason}): set XDG_CACHE_HOME to a writable directory`,
          ),
        ),
      ),
    );
  });
