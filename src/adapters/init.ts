/** `mshape init`: writes a new repo from the package's template, installs it and commits it. */
import { copyFile, mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { basename, dirname, relative } from "node:path";
import { Effect } from "effect";
import { OWNABLE_FILES } from "../core/conventions.ts";
import { VENDOR_DIR, vendoredSpecOf } from "../core/dep.ts";
import { HANDOFFS_LINK, handoffsLink, handoffsStore } from "../core/layout.ts";
import { scaffold, type Toolchain } from "../core/scaffold.ts";
import { resolveConfig } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { runTool } from "./process.ts";
import { fileDigest } from "./release.ts";
import { installSkills, readTree } from "./skills.ts";

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

const isEmptyOrMissing = (dir: string) =>
  Effect.promise(() =>
    readdir(dir).then(
      (entries) => entries.length === 0,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    ),
  );

/**
 * The handoffs store under git's common directory, and the two links to it. Relative links,
 * so the repo still works after it is moved. A failure is a note with the commands to finish:
 * by now the repo exists, and init refuses to run over it again.
 */
const stateDirectory = (target: string, name: string) =>
  Effect.gen(function* () {
    const byHand = `In ${name}/ run \`mkdir -p .agents .git/monkeyshape/handoffs && ln -s ../.git/monkeyshape/handoffs .agents/handoffs && ln -s .git/monkeyshape/handoffs ${HANDOFFS_LINK}\``;
    const common = yield* run(target, [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    if (common.code !== 0)
      return `the handoffs store is not set up: git did not name its directory. ${byHand}:\n  ${tail(common.output)}`;
    const store = handoffsStore(common.output);
    return yield* Effect.promise(async () => {
      try {
        await mkdir(store, { recursive: true });
        // git answers with real paths; a link computed from a symlinked path would miss.
        const repo = await realpath(target);
        for (const link of [handoffsLink(repo), `${repo}/${HANDOFFS_LINK}`]) {
          await mkdir(dirname(link), { recursive: true });
          await symlink(relative(dirname(link), store), link);
        }
        return undefined;
      } catch (cause) {
        return `the handoffs store is not fully set up (${String(cause)}). ${byHand}, skipping what exists.`;
      }
    });
  });

/**
 * `bd init` without its AGENTS.md block, and prime capped at the budgets `mshape check` holds.
 * `bd init` keeps the template's `.beads/PRIME.md`, which `bd prime` prints in place of bd's
 * default text; `agent.profile team-maintainer` makes that default agree with AGENTS.md on
 * git authority (agents commit and push) for whenever PRIME.md is missing.
 * prime caps characters and the budget counts UTF-8 bytes, so the character cap is only a
 * backstop: while the check passes, memories are within the byte budget, hence also within
 * the same number of characters, and prime never truncates them.
 */
const beads = (target: string, name: string) =>
  Effect.gen(function* () {
    const { memories, memoryBytes } = resolveConfig({}).budgets;
    const steps = [
      ["bd", "init", "--skip-agents", "--non-interactive", "--quiet", "--prefix", name],
      ["bd", "config", "set", "prime.max-memories", String(memories)],
      ["bd", "config", "set", "prime.max-memory-chars", String(memoryBytes)],
      ["bd", "config", "set", "agent.profile", "team-maintainer"],
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

/**
 * bd's anonymous usage metrics are a per-user setting (`bd config set metrics.disabled` writes
 * the user's config even from inside a repo), so init never changes them: it says how, once,
 * when they are on.
 */
const metricsNote = (target: string) =>
  Effect.gen(function* () {
    if (Bun.which("bd") === null) return undefined;
    const got = yield* run(target, ["bd", "config", "get", "metrics.disabled"]);
    if (got.code === 0 && got.output.split("\n").at(-1)?.trim() === "true") return undefined;
    return "bd sends anonymous usage metrics from this machine. That is a setting of your user, not of the repo, so init leaves it alone; to turn it off for every repo, run `bd metrics off`";
  });

/** Where init puts a tarball given to `--from`, repo-relative, so every clone resolves it. */
export const vendoredPath = (tarball: string): string => `${VENDOR_DIR}/${basename(tarball)}`;

/** The dependency spec for a tarball given to `--from`. */
export const vendoredSpec = (tarball: string): string => vendoredSpecOf(vendoredPath(tarball));

/**
 * `packageRoot` is the installed monkeyshape: its `template/` and `skills/` are copied.
 * `tarball`, from `--from`, is copied into `vendor/` and `toolchain.monkeyshape` should be its
 * `vendoredSpec`: a path relative to the repo, never one that resolves only on this machine.
 */
export const initRepo = (
  target: string,
  name: string,
  packageRoot: string,
  toolchain: Toolchain,
  tarball?: string,
) =>
  Effect.gen(function* () {
    if (!(yield* isEmptyOrMissing(target)))
      return yield* Effect.fail(fail(target, "exists and is not empty; init only creates repos"));
    /** Past this point the directory exists, and init won't run over it again. */
    const partial = (reason: string) =>
      fail(target, `${reason}. Delete ${target} and run mshape init again`);
    const decoder = new TextDecoder();
    const template = new Map(
      [...(yield* readTree(`${packageRoot}/template`))].map(
        ([path, bytes]) => [path, decoder.decode(bytes)] as const,
      ),
    );
    if (template.size === 0)
      return yield* Effect.fail(fail(packageRoot, "has no template/; reinstall monkeyshape"));
    // A tarball is recorded with its digest, so the files check verifies it from the first gate.
    const vendored =
      tarball === undefined
        ? undefined
        : {
            path: vendoredPath(tarball),
            package: "monkeyshape",
            sha256: yield* fileDigest(tarball).pipe(
              Effect.mapError((error) => fail(tarball, error.reason)),
            ),
          };
    const files = scaffold(name, template, toolchain, vendored);
    yield* Effect.tryPromise({
      try: async () => {
        for (const [path, text] of files) {
          await mkdir(dirname(`${target}/${path}`), { recursive: true });
          await Bun.write(`${target}/${path}`, text);
        }
      },
      catch: (cause) => partial(`cannot write the template: ${String(cause)}`),
    });
    const done = [`wrote ${files.size} files`];
    const notes: Array<string> = [];
    if (tarball !== undefined) {
      const copy = `${target}/${vendoredPath(tarball)}`;
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(dirname(copy), { recursive: true });
          await copyFile(tarball, copy);
        },
        catch: (cause) => partial(`cannot copy ${tarball} into vendor/: ${String(cause)}`),
      });
      done.push(`monkeyshape from vendor/${basename(tarball)}`);
      notes.push(
        `monkeyshape is installed from vendor/${basename(tarball)}, which is committed so every clone and CI resolve it. Once a release of it is on npm, run \`bun add -d monkeyshape@<version>\`, delete vendor/ and its entry in shape.config.ts's files.vendored, and commit`,
      );
    }
    // init wrote PRIME.md and the PR template from the package, so sync owns them from the start.
    const skills = yield* installSkills(`${packageRoot}/skills`, target, {
      files: OWNABLE_FILES,
    }).pipe(Effect.mapError((error) => partial(`cannot install the skills: ${error.reason}`)));
    done.push(`${skills.sync.added.length} shared skills`);

    const git = yield* run(target, ["git", "init", "--quiet", "--initial-branch=main"]);
    if (git.code !== 0) return yield* Effect.fail(partial(`git init failed: ${git.output}`));
    done.push("git init (branch main)");

    const stateNote = yield* stateDirectory(target, name);
    if (stateNote === undefined) done.push("handoffs store");
    else notes.push(stateNote);

    const beadsNote = yield* beads(target, name);
    if (beadsNote === undefined) done.push("bd init");
    else notes.push(beadsNote);
    const metrics = yield* metricsNote(target);
    if (metrics !== undefined) notes.push(metrics);

    // The current bun, not `bun` from PATH: it is the one running mshape, so it exists.
    const install = yield* run(target, [process.execPath, "install"]);
    if (install.code === 0) {
      done.push("bun install");
      // The installed package's own sync: skills, PRIME.md and hooks then match the version
      // the repo depends on, even when this mshape is another one.
      const synced = yield* run(target, [process.execPath, "node_modules/.bin/mshape", "sync"]);
      if (synced.code !== 0)
        notes.push(
          `the installed monkeyshape's sync failed, so the first gate may fail; run \`bun run --silent mshape sync\`:\n  ${tail(synced.output)}`,
        );
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
