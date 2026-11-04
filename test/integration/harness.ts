/** What the integration tests that create repos with `mshape init` share. */
import { join } from "node:path";
import { Effect } from "effect";
import { packWorkingTree } from "../../src/adapters/release.ts";

export const ROOT = join(import.meta.dir, "..", "..");

/** A CI runner has no git identity; init's first commit, and every later one, needs one. */
const IDENTITY = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

/** CI runners have no bd: what needs it is covered there only by the no-bd paths. */
export const HAS_BD = Bun.which("bd") !== null;

export const run = async (
  cwd: string,
  command: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => {
  const child = Bun.spawn([...command], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...IDENTITY, ...env },
  });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  return { code: await child.exited, output: `${stdout}${stderr}` };
};

/**
 * Packs this checkout into `dir` as `bun run release pack` does, with a development version
 * unless it is the release itself; returns the tarball's path.
 */
export const pack = (dir: string): Promise<string> => Effect.runPromise(packWorkingTree(ROOT, dir));

/** `mshape init` from this checkout's source, run in `cwd`. */
export const initFromSource = (
  cwd: string,
  args: ReadonlyArray<string>,
  env: Record<string, string> = {},
) => run(cwd, [process.execPath, join(ROOT, "src", "cli", "main.ts"), "init", ...args], env);

/**
 * Notes init printed that this machine doesn't explain. Without bd (as in CI) bd's is
 * expected; so is the one for a vendored `--from` tarball, and bd's metrics notice, which
 * depends on the user's own bd config. Anything else, a failed install or format, fails.
 */
export const unexpectedNotes = (output: string): ReadonlyArray<string> =>
  output
    .split("\n")
    .filter((line) => line.startsWith("note:"))
    .filter((line) => HAS_BD || !line.startsWith("note: bd is not on PATH"))
    .filter((line) => !line.startsWith("note: monkeyshape is installed from vendor/"))
    .filter((line) => !line.startsWith("note: bd sends anonymous usage metrics"));
