/**
 * The compiled `mshape`'s entry, called by the module `bun run release` generates
 * (`binaryEntry`): it unpacks the files the binary carries, then runs the CLI as Bun would.
 * The CLI is imported only after, so every module that reads its own files sees them unpacked.
 */
import { tmpdir } from "node:os";
import * as Effect from "effect/Effect";
import { unpackOwnFiles } from "../adapters/launch.ts";
import { cacheRoot } from "../core/launch.ts";

export const start = async (
  files: Readonly<Record<string, string>>,
  version: string,
  digest: string,
): Promise<void> => {
  const env = { XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"], HOME: process.env["HOME"] };
  const failure = await Effect.runPromise(
    unpackOwnFiles(files, cacheRoot(env, tmpdir()), version, digest).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => undefined }),
    ),
  );
  if (failure !== undefined) {
    console.error(`mshape: ${failure}`);
    process.exitCode = 1;
    return;
  }
  const { runMain } = await import("./main.ts");
  await runMain();
};
