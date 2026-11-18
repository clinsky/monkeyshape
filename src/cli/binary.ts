/**
 * The compiled `mshape`'s entry, called by the module `bun run release` generates
 * (`binaryEntry`). It is the launcher first: inside a repo whose `shape.toml` pins another
 * `mshape`, it runs that one (`launchPlan`). Otherwise it unpacks the files it carries and runs
 * the CLI as Bun would, imported only after, so every module that reads its own files sees
 * them unpacked.
 */
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import * as Effect from "effect/Effect";
import {
  markCompiled,
  pinnedBinary,
  readPin,
  recordedSums,
  unpackOwnFiles,
} from "../adapters/launch.ts";
import { BUN_MISSING, bunPath } from "../adapters/process.ts";
import { cacheRoot, LAUNCHED_ENV, launchPlan, RELEASES_URL } from "../core/launch.ts";
import { platformOf, unsupportedPlatform } from "../core/tools.ts";

const fail = (message: string): void => {
  console.error(`mshape: ${message}`);
  process.exitCode = 1;
};

/** Runs `argv` with this command's arguments and stdio, as the launched `mshape`. */
const handOff = async (argv: ReadonlyArray<string>, version: string): Promise<void> => {
  const child = Bun.spawn([...argv, ...process.argv.slice(2)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, [LAUNCHED_ENV]: version },
  });
  process.exitCode = await child.exited;
};

export const start = async (
  files: Readonly<Record<string, string>>,
  version: string,
  digest: string,
): Promise<void> => {
  markCompiled();
  const env = { XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"], HOME: process.env["HOME"] };
  const cache = cacheRoot(env, tmpdir());
  const found = await Effect.runPromise(readPin(process.cwd()));
  const plan = launchPlan(
    found?.pin,
    { version, recordedSums: await Effect.runPromise(recordedSums(process.execPath)) },
    (process.env[LAUNCHED_ENV] ?? "") !== "",
  );
  if (plan.kind === "refuse") return fail(plan.message);
  if (plan.kind === "dev") {
    // Paths in the pin are the repo's, wherever in it the command runs.
    const [program = "", ...rest] = plan.argv;
    const root = found?.root ?? process.cwd();
    const args = rest.map((arg) =>
      !isAbsolute(arg) && existsSync(join(root, arg)) ? join(root, arg) : arg,
    );
    const bun = program === "bun" ? bunPath() : program;
    if (bun === undefined) return fail(`shape.toml's [mshape] dev runs bun, but ${BUN_MISSING}`);
    return handOff([bun, ...args], "dev");
  }
  if (plan.kind === "pinned") {
    const platform = platformOf(process.platform, process.arch);
    if (platform === undefined) return fail(unsupportedPlatform(process.platform, process.arch));
    const releases = process.env["MSHAPE_RELEASES_URL"] || RELEASES_URL;
    const pinned = await Effect.runPromise(
      pinnedBinary(cache, releases, plan.version, plan.sums, platform),
    );
    if (pinned.state === "refused") return fail(pinned.message);
    return handOff([pinned.path], plan.version);
  }
  const failure = await Effect.runPromise(
    unpackOwnFiles(files, cache, version, digest).pipe(
      Effect.match({ onFailure: (error) => error.message, onSuccess: () => undefined }),
    ),
  );
  if (failure !== undefined) return fail(failure);
  const { runMain } = await import("./main.ts");
  await runMain();
};
