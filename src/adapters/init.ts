/** `mshape init`: writes a new repo from the package's template, installs it and commits it. */
import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { scaffold, type Toolchain } from "../core/scaffold.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { runTool } from "./process.ts";

export interface InitResult {
  /** What was done, one line each. */
  readonly done: ReadonlyArray<string>;
  /** What was skipped or failed and how to finish it by hand; the repo still exists. */
  readonly notes: ReadonlyArray<string>;
}

const fail = (path: string, reason: string) =>
  new WorkspaceError({ operation: "init", path, reason });

/** A command's exit code and combined output; one that can't start exits -1 with the reason. */
const run = (cwd: string, command: ReadonlyArray<string>) =>
  Effect.map(runTool(cwd, command), (ran) => ({
    code: ran.code,
    output: `${ran.stdout}${ran.stderr}`.trim(),
  }));

/** The last lines of a tool's output: enough to say why it failed. */
const tail = (output: string): string => output.split("\n").slice(-3).join("\n  ");

const readTemplate = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const files = new Map<string, string>();
      for await (const path of new Bun.Glob("**").scan({ cwd: dir, dot: true }))
        files.set(path, await Bun.file(`${dir}/${path}`).text());
      return files;
    },
    catch: (cause) => fail(dir, `cannot read the template: ${String(cause)}`),
  });

const isEmptyOrMissing = (dir: string) =>
  Effect.promise(() =>
    readdir(dir).then(
      (entries) => entries.length === 0,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    ),
  );

export const initRepo = (target: string, name: string, templateDir: string, toolchain: Toolchain) =>
  Effect.gen(function* () {
    if (!(yield* isEmptyOrMissing(target)))
      return yield* Effect.fail(fail(target, "exists and is not empty; init only creates repos"));
    const files = scaffold(name, yield* readTemplate(templateDir), toolchain);
    yield* Effect.tryPromise({
      try: async () => {
        for (const [path, text] of files) {
          await mkdir(dirname(`${target}/${path}`), { recursive: true });
          await Bun.write(`${target}/${path}`, text);
        }
      },
      catch: (cause) => fail(target, `cannot write the template: ${String(cause)}`),
    });
    const done = [`wrote ${files.size} files`];
    const notes: Array<string> = [];

    const git = yield* run(target, ["git", "init", "--quiet", "--initial-branch=main"]);
    if (git.code !== 0) return yield* Effect.fail(fail(target, `git init failed: ${git.output}`));
    done.push("git init (branch main)");

    // The current bun, not `bun` from PATH: it is the one running mshape, so it exists.
    const install = yield* run(target, [process.execPath, "install"]);
    if (install.code === 0) {
      done.push("bun install");
      // The generated JSON is laid out by JSON.stringify; the repo's own biome has the last word.
      const format = yield* run(target, [
        process.execPath,
        "node_modules/.bin/biome",
        "format",
        "--write",
        ".",
      ]);
      if (format.code !== 0)
        notes.push(`biome format failed; run \`bun run fix\`:\n  ${tail(format.output)}`);
    } else
      notes.push(
        `bun install failed, so bun.lock is not committed. Run \`bun install\` in ${name}/ and commit bun.lock:\n  ${tail(install.output)}`,
      );

    const add = yield* run(target, ["git", "add", "--all"]);
    const commit =
      add.code === 0
        ? yield* run(target, ["git", "commit", "--quiet", "-m", `Start ${name} with mshape init`])
        : add;
    if (commit.code === 0) done.push("first commit");
    else
      notes.push(
        `the first commit failed; set your git identity, then \`git add --all && git commit\`:\n  ${tail(commit.output)}`,
      );
    return { done, notes } satisfies InitResult;
  });
