#!/usr/bin/env bun
/**
 * `bun src/cli/compile.ts <job.json>`: compiles one `mshape` binary (`bundleBinary`), run by
 * `compileBinaries` in a process of its own whose directory is the build's stage, where Bun
 * writes its compile's scratch file. Not a command anyone runs by hand.
 */
import * as Effect from "effect/Effect";
import { bundleBinary, type CompileJob } from "../adapters/release.ts";

if (import.meta.main) {
  const [file = ""] = process.argv.slice(2);
  const job = (await Bun.file(file).json()) as CompileJob;
  const failure = await Effect.runPromise(
    bundleBinary(job).pipe(
      Effect.match({ onFailure: (error) => error.reason, onSuccess: () => undefined }),
    ),
  );
  if (failure !== undefined) {
    console.error(failure);
    process.exitCode = 1;
  }
}
