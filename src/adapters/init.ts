/** `mshape init`: writes a new repo from the package's template, installs it and commits it. */
import { mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { Effect } from "effect";
import { HANDOFFS_LINK, handoffsLink, handoffsStore } from "../core/layout.ts";
import { scaffold, type Toolchain } from "../core/scaffold.ts";
import { resolveConfig } from "../schemas/config.ts";
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

/**
 * The handoffs store under git's common directory, and the two links to it. Relative links,
 * so the repo still works after it is moved.
 */
const stateDirectory = (target: string) =>
  Effect.gen(function* () {
    const common = yield* run(target, [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (common.code !== 0)
      return yield* Effect.fail(fail(target, `cannot find git's directory: ${common.output}`));
    const store = handoffsStore(common.output);
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(store, { recursive: true });
        // git answers with real paths; a link computed from a symlinked path would miss.
        const repo = await realpath(target);
        for (const link of [handoffsLink(repo), `${repo}/${HANDOFFS_LINK}`]) {
          await mkdir(dirname(link), { recursive: true });
          await symlink(relative(dirname(link), store), link);
        }
      },
      catch: (cause) => fail(store, `cannot create the handoffs store: ${String(cause)}`),
    });
  });

/** `bd init` without its AGENTS.md block, and prime capped at the budgets `mshape check` holds. */
const beads = (target: string, name: string) =>
  Effect.gen(function* () {
    const { memories, memoryBytes } = resolveConfig({}).budgets;
    const steps = [
      ["bd", "init", "--skip-agents", "--non-interactive", "--quiet", "--prefix", name],
      ["bd", "config", "set", "prime.max-memories", String(memories)],
      ["bd", "config", "set", "prime.max-memory-chars", String(memoryBytes)],
    ];
    const later = steps.map((step) => step.join(" ")).join(" && ");
    if (Bun.which("bd") === null)
      return `bd is not on PATH, so beads is not set up. Install bd, then in ${name}/ run \`${later}\` and commit .beads/`;
    for (const step of steps) {
      const result = yield* run(target, step);
      if (result.code !== 0)
        return `\`${step.join(" ")}\` failed, so beads is not fully set up. In ${name}/ run \`${later}\`:\n  ${tail(result.output)}`;
    }
    return undefined;
  });

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

    yield* stateDirectory(target);
    done.push("handoffs store");

    const beadsNote = yield* beads(target, name);
    if (beadsNote === undefined) done.push("bd init");
    else notes.push(beadsNote);

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

    // `bd init` commits its own files; fold that into the one first commit, message and all.
    const bdCommit = yield* run(target, ["git", "rev-parse", "--verify", "--quiet", "HEAD"]);
    if (bdCommit.code === 0) yield* run(target, ["git", "update-ref", "-d", "HEAD"]);
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
