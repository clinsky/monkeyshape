/**
 * `mshape track new | list | current | rm` against git and the filesystem. Every path comes
 * from `src/core/layout.ts`, and the main checkout from git's common directory, so each
 * command works the same from the main checkout and from any worktree. The decisions are in
 * `src/core/tracks.ts`.
 */
import { lstat, mkdir, readdir, readlink, realpath, symlink, unlink } from "node:fs/promises";
import { posix } from "node:path";
import { Effect } from "effect";
import { parseHandoff, stubHandoff } from "../core/handoff.ts";
import {
  HANDOFFS_LINK,
  handoffPath,
  handoffsLink,
  handoffsStore,
  MAIN_BRANCH,
  mainCheckout,
  TRACK_NAME,
  trackBranch,
  trackOf,
  worktreePath,
  worktreesDir,
} from "../core/layout.ts";
import {
  currentTrack,
  describeStep,
  formatTracks,
  nameProblem,
  parseWorktrees,
  planRm,
  type RmStep,
  sharedPathProblems,
  type TrackRow,
  type Worktree,
} from "../core/tracks.ts";
import { TrackError, WorkspaceError } from "../schemas/errors.ts";
import { loadConfig } from "./config.ts";

export const refuse = (reason: string) => Effect.fail(new TrackError({ reason }));

export const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.try({
    try: () => {
      const child = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
      return {
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString().trim(),
        code: child.exitCode,
      };
    },
    catch: (cause) =>
      new WorkspaceError({
        operation: "run",
        path: `git ${args.join(" ")}`,
        reason: String(cause),
      }),
  });

/** Git's stdout, trimmed; a non-zero exit is a TrackError carrying git's own message. */
export const gitOk = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(git(cwd, args), (result) =>
    result.code === 0
      ? Effect.succeed(result.stdout.trim())
      : refuse(`\`git ${args.join(" ")}\` failed: ${result.stderr || `exit ${result.code}`}`),
  );

export const lexists = (path: string) =>
  Effect.promise(() =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  );

/** Symlinks resolved. A missing path stays as is. */
const real = (path: string) => Effect.promise(() => realpath(path).catch(() => path));

/** A branch as a full ref: a short name would resolve to a same-named tag first. */
const head = (branch: string): string => `refs/heads/${branch}`;

/**
 * Paths from git, in the layout's terms: resolved, then put back under `<repo>/.agents/worktrees`
 * when they are inside it, even if that directory is a symlink (to another disk, say).
 */
const canonical = (repo: string) =>
  Effect.map(
    real(worktreesDir(repo)),
    (resolved) => (path: string) =>
      Effect.map(real(path), (path) =>
        path.startsWith(`${resolved}/`)
          ? `${worktreesDir(repo)}${path.slice(resolved.length)}`
          : path,
      ),
  );

export const fs = <A>(operation: string, path: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new WorkspaceError({ operation, path, reason: String(cause) }),
  });

/** Git's common directory and the main checkout, from git: never by walking up directories. */
export const locate = (cwd: string) =>
  Effect.gen(function* () {
    const found = yield* git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (found.code !== 0) return yield* refuse(`${cwd} is not inside a git repository`);
    const common = yield* real(found.stdout.trim());
    return { common, repo: mainCheckout(common) };
  });

export const worktrees = (repo: string) =>
  Effect.gen(function* () {
    const listed = parseWorktrees(yield* gitOk(repo, ["worktree", "list", "--porcelain"]));
    const resolve = yield* canonical(repo);
    return yield* Effect.forEach(listed, (worktree) =>
      Effect.map(resolve(worktree.path), (path): Worktree => ({ ...worktree, path })),
    );
  });

const branchExists = (repo: string, branch: string) =>
  Effect.map(
    git(repo, ["show-ref", "--verify", "--quiet", head(branch)]),
    (result) => result.code === 0,
  );

const requireMain = (repo: string) =>
  Effect.flatMap(branchExists(repo, MAIN_BRANCH), (found) =>
    found
      ? Effect.void
      : refuse(`this repository has no \`${MAIN_BRANCH}\` branch: tracks branch from it`),
  );

const unmergedCount = (repo: string, branch: string) =>
  Effect.map(gitOk(repo, ["rev-list", "--count", `${head(MAIN_BRANCH)}..${head(branch)}`]), Number);

/**
 * `link` → `target`. Relative when the link's real directory is inside the repo, so it survives
 * moving the repo; measured from that real directory, since that is where the OS resolves it
 * (`.agents/worktrees` may be a symlink). Absolute when the directory lies outside the repo:
 * a worktree on another disk doesn't move with the repo anyway.
 */
export const linkTo = (repo: string, link: string, target: string) =>
  Effect.gen(function* () {
    const dir = posix.dirname(link);
    yield* fs("mkdir", dir, () => mkdir(dir, { recursive: true }));
    const realDir = yield* real(dir);
    const inside = realDir === repo || realDir.startsWith(`${repo}/`);
    const text = inside ? posix.relative(realDir, target) : target;
    yield* fs("symlink", link, () => symlink(text, link));
  });

/**
 * A missing link is created, and so is one of ours that dangles: a link holds no data. One
 * that resolves elsewhere, or isn't a link, is left alone with a note.
 */
const ensureLink = (repo: string, link: string, target: string) =>
  Effect.gen(function* () {
    if (!(yield* lexists(link))) {
      yield* linkTo(repo, link, target);
      return `linked ${link} -> ${target}`;
    }
    const state = yield* Effect.promise(() =>
      readlink(link).then(
        () =>
          realpath(link).then(
            async (resolved) => (resolved === (await realpath(target)) ? "ok" : "elsewhere"),
            () => "dangling" as const,
          ),
        () => "not a link" as const,
      ),
    );
    if (state === "ok") return undefined;
    if (state === "dangling") {
      yield* fs("unlink", link, () => unlink(link));
      yield* linkTo(repo, link, target);
      return `relinked ${link} -> ${target} (it dangled)`;
    }
    return `note: ${link} exists but is not a link to ${target}; left alone`;
  });

/** The store, `.agents/handoffs` and every checkout's `.handoffs`: what `git clean` may have removed. */
const ensureHandoffLinks = (common: string, repo: string, checkouts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const store = handoffsStore(common);
    yield* fs("mkdir", store, () => mkdir(store, { recursive: true }));
    const links = [handoffsLink(repo), ...[repo, ...checkouts].map((c) => `${c}/${HANDOFFS_LINK}`)];
    const said = yield* Effect.forEach(links, (link) => ensureLink(repo, link, store));
    return said.filter((line): line is string => line !== undefined);
  });

export const ignored = (repo: string, path: string) =>
  Effect.map(git(repo, ["check-ignore", "-q", path]), (result) => result.code === 0);

/** A shared path git tracks in `main`, itself or through a parent that is a file: it would be checked out. */
const trackedInMain = (repo: string, path: string) =>
  Effect.gen(function* () {
    const segments = path.split("/");
    for (let end = 1; end <= segments.length; end++) {
      const prefix = segments.slice(0, end).join("/");
      const type = yield* git(repo, ["cat-file", "-t", `${head(MAIN_BRANCH)}:${prefix}`]);
      if (type.code !== 0) return false;
      if (end === segments.length || type.stdout.trim() !== "tree") return true;
    }
    return false;
  });

/**
 * Shared paths come from the main checkout's `shape.config.ts`: they name the main checkout's
 * data, whichever checkout the command runs from.
 */
export const trackNew = (cwd: string, track: string, date: string) =>
  Effect.gen(function* () {
    const invalid = nameProblem(track);
    if (invalid !== undefined) return yield* refuse(invalid);
    const { common, repo } = yield* locate(cwd);
    const config = yield* loadConfig(repo);
    const shared = config.tracks.sharedPaths;
    const problems = sharedPathProblems(shared);
    if (problems.length > 0) return yield* refuse(problems.join("\n"));
    yield* requireMain(repo);

    const path = worktreePath(repo, track);
    const branch = trackBranch(track);
    const stub = stubHandoff(track, date, path);
    if ("problems" in stub) return yield* refuse(stub.problems.join("\n"));
    if (yield* lexists(path)) return yield* refuse(`track \`${track}\` exists: ${path} is there`);
    if ((yield* worktrees(repo)).some((worktree) => worktree.path === path))
      return yield* refuse(
        `git still has a worktree registered at ${path}: run \`git worktree prune\`, or \`mshape track rm ${track}\``,
      );
    if (yield* branchExists(repo, branch))
      return yield* refuse(
        `track \`${track}\` exists: branch \`${branch}\` is there. Finish it with \`mshape track rm ${track}\`, or pick another name`,
      );
    const notes: Array<string> = [];
    const linkable: Array<string> = [];
    for (const entry of shared) {
      if (yield* trackedInMain(repo, entry))
        return yield* refuse(
          `shared path \`${entry}\` is tracked in \`${MAIN_BRANCH}\`, so the worktree would already have it: a shared path must be gitignored, never tracked`,
        );
      if (yield* lexists(`${repo}/${entry}`)) linkable.push(entry);
      else notes.push(`note: shared path \`${entry}\` is missing in ${repo}; not linked`);
    }
    for (const [what, at] of [
      ["the worktrees directory", posix.relative(repo, path)],
      [HANDOFFS_LINK, HANDOFFS_LINK],
    ] as const)
      if (!(yield* ignored(repo, at)))
        notes.push(`note: ${what} (\`${at}\`) is not gitignored; add it to .gitignore`);

    yield* gitOk(repo, ["worktree", "add", "--quiet", "-b", branch, path, head(MAIN_BRANCH)]);
    const said = [`created ${path} on \`${branch}\` from \`${MAIN_BRANCH}\``];
    // From here the track exists: a failure must say what was done and how to undo it.
    const finish = Effect.gen(function* () {
      said.push(...(yield* ensureHandoffLinks(common, repo, [path])));
      for (const entry of linkable) {
        const link = `${path}/${entry}`;
        if (yield* lexists(link))
          return yield* refuse(
            `${link} already exists in the new worktree, so shared path \`${entry}\` is not linked. A shared path must be gitignored, never tracked`,
          );
        yield* linkTo(repo, link, `${repo}/${entry}`);
        said.push(`linked ${link} -> ${repo}/${entry}`);
      }
      const handoff = handoffPath(common, track);
      if (yield* lexists(handoff)) said.push(`kept the existing handoff ${handoff}`);
      else {
        yield* fs("write", handoff, () => Bun.write(handoff, stub.text));
        said.push(`wrote the stub handoff ${handoff}`);
      }
    });
    yield* finish.pipe(
      Effect.catch((error) =>
        refuse(
          [
            `track new ${track}: stopped: ${error.message}`,
            ...said.map((line) => `done: ${line}`),
            `undo with \`mshape track rm ${track}\`, fix the cause, then run \`mshape track new ${track}\` again`,
          ].join("\n  "),
        ),
      ),
    );
    return [...notes, ...said, `next: cd ${path}, then run /track`].join("\n");
  });

export const trackList = (cwd: string) =>
  Effect.gen(function* () {
    const { common, repo } = yield* locate(cwd);
    yield* requireMain(repo);
    const registered = yield* worktrees(repo);
    const byTrack = new Map<string, Worktree>();
    for (const worktree of registered) {
      const track = trackOf(repo, worktree.path);
      if (track !== undefined) byTrack.set(track, worktree);
    }
    const branches = (yield* gitOk(repo, [
      "for-each-ref",
      // The name after `refs/heads/track/`; `:short` may say `heads/track/x` when a tag shares it.
      "--format=%(refname:lstrip=3)",
      "refs/heads/track/",
    ]))
      .split("\n")
      .filter((line) => line !== "");
    const store = handoffsStore(common);
    const handoffs = yield* Effect.promise(() =>
      readdir(store).then(
        (files) => files.filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)),
        () => [],
      ),
    );
    const tracks = [...new Set([...byTrack.keys(), ...branches, ...handoffs])]
      .filter((track) => TRACK_NAME.test(track))
      .sort();

    const checkouts = [...byTrack.values()].map((worktree) => worktree.path);
    const present = yield* Effect.filter(checkouts, lexists);
    const notes = yield* ensureHandoffLinks(common, repo, present);

    const rows = yield* Effect.forEach(tracks, (track) =>
      Effect.gen(function* () {
        const handoff = handoffPath(common, track);
        const text = (yield* lexists(handoff))
          ? yield* fs("read", handoff, () => Bun.file(handoff).text())
          : undefined;
        const parsed = text === undefined ? undefined : parseHandoff(text);
        const worktree = byTrack.get(track);
        const row: TrackRow = {
          track,
          status: parsed === undefined ? "none" : "problems" in parsed ? "invalid" : parsed.status,
          problems: parsed !== undefined && "problems" in parsed ? parsed.problems : undefined,
          ahead: branches.includes(track)
            ? yield* unmergedCount(repo, trackBranch(track))
            : undefined,
          worktree: worktree === undefined ? undefined : posix.relative(repo, worktree.path),
          worktreeBranch:
            worktree === undefined || worktree.branch === trackBranch(track)
              ? undefined
              : (worktree.branch ?? "detached HEAD"),
        };
        return row;
      }),
    );
    return [...notes, formatTracks(rows)].join("\n");
  });

export const trackCurrent = (cwd: string) =>
  Effect.gen(function* () {
    const { repo } = yield* locate(cwd);
    const toplevel = yield* Effect.flatMap(
      gitOk(cwd, ["rev-parse", "--show-toplevel"]),
      yield* canonical(repo),
    );
    const found = currentTrack(repo, toplevel, yield* worktrees(repo));
    return "track" in found ? found.track : yield* refuse(found.reason);
  });

/** `say` prints at once: what `--force` will discard is said before it happens. */
export const trackRm = (
  cwd: string,
  track: string,
  options: { readonly force: boolean; readonly keepHandoff: boolean },
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const invalid = nameProblem(track);
    if (invalid !== undefined) return yield* refuse(invalid);
    const { common, repo } = yield* locate(cwd);
    yield* requireMain(repo);
    const path = worktreePath(repo, track);
    const branch = trackBranch(track);
    const registered = yield* worktrees(repo);
    const worktree = registered.find((candidate) => candidate.path === path);
    const pathExists = yield* lexists(path);
    const status =
      worktree !== undefined && pathExists
        ? yield* git(path, ["status", "--porcelain", "--untracked-files=all"])
        : { stdout: "", stderr: "", code: 0 };
    const changes =
      status.code === 0 ? status.stdout.split("\n").filter((line) => line.trim() !== "") : [];
    const hasBranch = yield* branchExists(repo, branch);
    const handoff = handoffPath(common, track);
    const plan = planRm({
      track,
      worktreePath: path,
      worktree,
      pathExists,
      changes,
      statusError: status.code === 0 ? undefined : status.stderr || `exit ${status.code}`,
      branchExists: hasBranch,
      unmerged: hasBranch ? yield* unmergedCount(repo, branch) : 0,
      branchCheckedOutAt: registered.filter(
        (candidate) => candidate.branch === branch && candidate.path !== path,
      ),
      handoffPath: handoff,
      handoffExists: yield* lexists(handoff),
      force: options.force,
      keepHandoff: options.keepHandoff,
    });
    if (plan.refusals.length > 0)
      return yield* refuse(
        [`track rm ${track}: refused, nothing removed`, ...plan.refusals].join("\n  "),
      );

    yield* Effect.forEach(plan.warnings, (warning) => say(`--force: ${warning}`));
    const run = (step: RmStep) =>
      step.kind === "worktree"
        ? gitOk(repo, ["worktree", "remove", ...(step.force ? ["--force"] : []), step.path])
        : step.kind === "branch"
          ? // Merged into `main` was checked above; `-d` would check against HEAD instead.
            gitOk(repo, ["branch", "-D", step.name])
          : Effect.mapError(
              fs("unlink", step.path, () => unlink(step.path)),
              (error) => new TrackError({ reason: error.message }),
            );
    const removed: Array<string> = [];
    for (const [index, step] of plan.steps.entries()) {
      const failed = yield* Effect.flip(run(step)).pipe(
        Effect.map((error) => error.message),
        Effect.orElseSucceed(() => undefined),
      );
      if (failed !== undefined)
        return yield* refuse(
          [
            `track rm ${track}: stopped at ${describeStep(step)}: ${failed}`,
            `removed: ${removed.join(", ") || "nothing"}`,
            `remains: ${plan.steps.slice(index).map(describeStep).join(", ")}`,
            `fix the cause, then run \`mshape track rm ${track}\` again to finish`,
          ].join("\n  "),
        );
      removed.push(describeStep(step));
    }
    yield* gitOk(repo, ["worktree", "prune"]);
    return [
      ...removed.map((what) => `removed ${what}`),
      ...plan.kept.map((what) => `kept ${what}`),
    ].join("\n");
  });
