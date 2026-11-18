/**
 * The running `mshape`: where its own files are. Run by Bun from a checkout or an npm install,
 * they sit beside `src/`; the compiled binary carries them inside itself and unpacks them once
 * per build into the machine's cache (`unpackedDir`), where `template/`, `skills/` and
 * `config/` are read like any package's.
 */
import { mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { unpackedDir } from "../core/launch.ts";
import { WorkspaceError } from "../schemas/errors.ts";

/** Set by the compiled binary's entry before the CLI loads; undefined under Bun. */
let unpackedRoot: string | undefined;

/** Whether this `mshape` is the compiled binary, whose `process.execPath` is itself. */
export const runningCompiled = (): boolean => unpackedRoot !== undefined;

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
        new WorkspaceError({ operation: "unpack", path: root, reason: String(cause) }),
    });
    if (!done)
      return yield* Effect.fail(
        new WorkspaceError({ operation: "unpack", path: root, reason: "not written" }),
      );
    unpackedRoot = root;
    return root;
  });
