/**
 * `mshape track new | list | current | rm` against git and the filesystem. Every path comes
 * from `src/core/layout.ts`, and the main checkout from git's common directory, so each
 * command works the same from the main checkout and from any worktree. The decisions are in
 * `src/core/tracks.ts`.
 */
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { posix } from "node:path";
import { Effect } from "effect";
import { migrateHandoff, parseHandoff, stubHandoff } from "../core/handoff.ts";
import {
  HANDOFFS_LINK,
  handoffPath,
  handoffsLink,
  handoffsStore,
  MAIN_BRANCH,
  mailboxDir,
  mailboxReadDir,
  mainCheckout,
  TRACK_NAME,
  trackBranch,
  trackOf,
  worktreePath,
  worktreesDir,
} from "../core/layout.ts";
import { decodeMessage } from "../core/mail.ts";
import {
  type BeadsById,
  type BeadsCheck,
  currentTrack,
  describeStep,
  formatTracks,
  hygieneWarnings,
  type MailboxFacts,
  nameProblem,
  openAfterMerge,
  openBeadsByTrack,
  ownPrs,
  parseTrackPrs,
  parseWorktrees,
  planRm,
  type RmStep,
  STARTED_KEY,
  sharedPathProblems,
  type TrackRow,
  trackDone,
  type Worktree,
} from "../core/tracks.ts";
import { TrackError, WorkspaceError } from "../schemas/errors.ts";
import { loadConfig } from "./config.ts";
import { beadRows } from "./workspace.ts";

export const refuse = (reason: string) => Effect.fail(new TrackError({ reason }));

export const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  /** `env` replaces the environment whole: the composition root builds it. */
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeout?: number;
    readonly stdin?: string;
  } = {},
) =>
  Effect.try({
    try: () => {
      const child = Bun.spawnSync(["git", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(options.env === undefined ? {} : { env: { ...options.env } }),
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
        ...(options.stdin === undefined ? {} : { stdin: Buffer.from(options.stdin) }),
      });
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

/**
 * What counts as merged: `main`, and its upstream (`origin/main`) when that ref exists, so a PR
 * merged on the remote counts before anyone pulls `main`. Full refs, for the reason `head` gives.
 */
export const mergeTargets = (repo: string) =>
  Effect.gen(function* () {
    const found = yield* git(repo, ["for-each-ref", "--format=%(upstream)", head(MAIN_BRANCH)]);
    const upstream = found.code === 0 ? found.stdout.trim() : "";
    const present =
      upstream !== "" &&
      (yield* git(repo, ["show-ref", "--verify", "--quiet", upstream])).code === 0;
    return present ? [head(MAIN_BRANCH), upstream] : [head(MAIN_BRANCH)];
  });

/** `refs/heads/main` → `main`, `refs/remotes/origin/main` → `origin/main`: as people say them. */
const shortRef = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, "");

const FETCH_TIMEOUT_MS = 30_000;

/**
 * Brings `main`'s upstream up to date, so `rm` sees a merge done on the remote. It only moves
 * remote-tracking refs, never a branch. `env` is from the composition root, with terminal
 * prompts off; SSH runs in batch mode unless the user configured their own SSH command. It
 * gives up after a while (git is killed; an ssh it started may outlive it briefly). A failure is a note, and the
 * judgement falls back to the refs already here.
 */
export const fetchUpstream = (repo: string, env: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const remote = (yield* git(repo, ["config", `branch.${MAIN_BRANCH}.remote`])).stdout.trim();
    const merge = (yield* git(repo, ["config", `branch.${MAIN_BRANCH}.merge`])).stdout.trim();
    if (remote === "" || merge === "") return undefined;
    // SSH batch mode only when the user has no SSH command of their own: an environment
    // variable overrides `core.sshCommand`, which picks deploy keys and accounts.
    const configured = (yield* git(repo, ["config", "--get", "core.sshCommand"])).stdout.trim();
    const ownSsh =
      configured !== "" || env["GIT_SSH_COMMAND"] !== undefined || env["GIT_SSH"] !== undefined;
    const fetched = yield* git(repo, ["fetch", "--quiet", remote, merge], {
      env: ownSsh ? env : { ...env, GIT_SSH_COMMAND: "ssh -o BatchMode=yes" },
      timeout: FETCH_TIMEOUT_MS,
    });
    const why =
      fetched.code === null
        ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
        : fetched.stderr || `exit ${fetched.code}`;
    return fetched.code === 0
      ? undefined
      : `couldn't fetch \`${MAIN_BRANCH}\` from \`${remote}\` (${why}), so merges done there since the last fetch aren't seen`;
  });

/** `git patch-id --stable` of a patch text: one id per commit, or one for a bare diff. */
const patchIds = (repo: string, patch: string) =>
  Effect.map(git(repo, ["patch-id", "--stable"], { stdin: patch }), (result) =>
    result.stdout
      .split("\n")
      .map((line) => line.split(" ")[0] ?? "")
      .filter((id) => id !== ""),
  );

/**
 * Whether merging the branch into `target` would change nothing, so its work is all there,
 * whichever way it got there. A clean merge is exact about content, so its answer is final
 * both ways. `unknown` when git can't say: before 2.38 (no `merge-tree --write-tree`), or on a
 * conflict.
 */
const contentMerged = (repo: string, branch: string, target: string) =>
  Effect.gen(function* () {
    const merged = yield* git(repo, ["merge-tree", "--write-tree", target, head(branch)]);
    const tree = yield* git(repo, ["rev-parse", `${target}^{tree}`]);
    if (merged.code !== 0 || tree.code !== 0) return "unknown" as const;
    return merged.stdout.split("\n")[0] === tree.stdout.trim() ? ("yes" as const) : ("no" as const);
  });

/**
 * The fallback when `contentMerged` can't say: the branch's changes are already in `target`
 * as patches, the whole change as one commit (a squash) or every commit one by one (a
 * rebase). Patch ids keep their default three lines of context. Without context they ignore
 * line numbers too, so one fixed copy of a repeated line would match another copy fixed in
 * `main`, and `rm` would delete unmerged work. With context, a squash after `main` edited a
 * nearby line isn't recognised, and `rm` asks for --force instead. Any git version.
 */
export const patchMerged = (repo: string, branch: string, target: string) =>
  Effect.gen(function* () {
    const found = yield* git(repo, ["merge-base", target, head(branch)]);
    if (found.code !== 0) return false;
    const base = found.stdout.trim();
    const since = (tip: string) =>
      gitOk(repo, ["log", "-p", "--no-merges", "--format=commit %H", `${base}..${tip}`]);
    const landed = new Set(yield* patchIds(repo, yield* since(target)));
    const whole = yield* patchIds(repo, yield* gitOk(repo, ["diff", base, head(branch)]));
    if (whole.length > 0 && whole.every((id) => landed.has(id))) return true;
    const each = yield* patchIds(repo, yield* since(head(branch)));
    return each.length > 0 && each.every((id) => landed.has(id));
  });

/**
 * Commits on the branch in no target, and whether its work is merged anyway, by any of the
 * ways a PR merges: a merge commit (every commit contained), a rebase or a squash. Content
 * decides when git can; patches only when it can't. Erring toward "unmerged" is the safe
 * side: it asks for --force, where a wrong "merged" deletes work without asking.
 */
const mergeState = (repo: string, branch: string, targets: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const ahead = Number(
      yield* gitOk(repo, ["rev-list", "--count", head(branch), "--not", ...targets]),
    );
    if (ahead === 0) return { ahead, merged: true };
    for (const target of targets) {
      const content = yield* contentMerged(repo, branch, target);
      if (content === "yes") return { ahead, merged: true };
      if (content === "unknown" && (yield* patchMerged(repo, branch, target)))
        return { ahead, merged: true };
    }
    return { ahead, merged: false };
  });

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

/**
 * Every bead, once, in the beads state `mshape check` uses (one loader, so the two can't
 * disagree about what a beads failure means): the open ones by track label, and each one's
 * status and labels by id.
 */
const trackBeads = (repo: string) =>
  Effect.map(beadRows(repo, ["--brief"]), (loaded) => ({
    integration: loaded.integration,
    byTrack: openBeadsByTrack(loaded.value ?? []),
    byId: new Map(
      (loaded.value ?? []).flatMap((row) => {
        const { id, status, issue_type, labels } = (row ?? {}) as Record<string, unknown>;
        return typeof id === "string" && typeof status === "string"
          ? [
              [
                id,
                {
                  status,
                  type: typeof issue_type === "string" ? issue_type : "",
                  labels: Array.isArray(labels)
                    ? labels.filter((label): label is string => typeof label === "string")
                    : [],
                },
              ] as const,
            ]
          : [];
      }),
    ) as BeadsById,
  }));

const GH_TIMEOUT_MS = 30_000;

/**
 * Every PR from a `track/*` branch, in one `gh` call, or why gh couldn't say: then done is
 * `unknown`, never `yes`.
 */
const trackPrs = (repo: string) =>
  Effect.try({
    try: () =>
      Bun.spawnSync(
        [
          "gh",
          "pr",
          "list",
          "--state",
          "all",
          "--limit",
          "1000",
          "--json",
          "number,state,headRefName,body,createdAt",
        ],
        { cwd: repo, stdout: "pipe", stderr: "pipe", timeout: GH_TIMEOUT_MS },
      ),
    catch: (cause) => cause,
  }).pipe(
    Effect.map((child) => {
      if (child.exitCode !== 0)
        return {
          reason: `\`gh pr list\` failed: ${child.stderr.toString().trim() || (child.exitCode === null ? `timed out after ${GH_TIMEOUT_MS / 1000}s` : `exit ${child.exitCode}`)}`,
        };
      const prs = parseTrackPrs(child.stdout.toString());
      return prs === undefined
        ? { reason: "`gh pr list` printed something that isn't a list of PRs" }
        : { prs: prs.filter((pr) => pr.headRefName.startsWith("track/")) };
    }),
    Effect.orElseSucceed(() => ({ reason: "`gh` is not on PATH" })),
  );

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
/**
 * When the track started: as `track new` recorded it, or, for a branch made before it did,
 * when the branch's reflog says it was created. Both go with the branch, so `track rm` then
 * `track new` starts a new one. Undefined when neither is there.
 */
const trackStarted = (repo: string, track: string) =>
  Effect.gen(function* () {
    const recorded = (yield* git(repo, ["config", "--get", STARTED_KEY(track)])).stdout.trim();
    if (recorded !== "" && !Number.isNaN(Date.parse(recorded))) return new Date(recorded);
    const reflog = yield* git(repo, [
      "log",
      "--walk-reflogs",
      "--date=unix",
      "--format=%gd",
      head(trackBranch(track)),
    ]);
    const oldest = /@\{(\d+)\}\s*$/.exec(reflog.stdout.trim())?.[1];
    return oldest === undefined ? undefined : new Date(Number(oldest) * 1000);
  });

/**
 * Where a new track branches: upstream `main` when it has commits local `main` lacks (merges
 * done on GitHub since the last pull), so the track starts from what will be its PR's base;
 * local `main` otherwise, which also covers no upstream and local commits not pushed yet.
 * Fetches first; a fetch that fails is said, and the refs as they are decide.
 */
const startPoint = (repo: string, fetchEnv: Readonly<Record<string, string | undefined>>) =>
  Effect.gen(function* () {
    const notes: Array<string> = [];
    const unfetched = yield* fetchUpstream(repo, fetchEnv);
    if (unfetched !== undefined) notes.push(`note: ${unfetched}`);
    const [local, upstream] = yield* mergeTargets(repo);
    const main = { ref: local ?? head(MAIN_BRANCH), name: MAIN_BRANCH, notes };
    if (upstream === undefined) return main;
    const count = (range: string) =>
      Effect.map(gitOk(repo, ["rev-list", "--count", range]), (out) => Number(out));
    const behind = yield* count(`${main.ref}..${upstream}`);
    const ahead = yield* count(`${upstream}..${main.ref}`);
    if (behind === 0) return main;
    if (ahead > 0) {
      notes.push(
        `note: \`${MAIN_BRANCH}\` and \`${shortRef(upstream)}\` have diverged (${ahead} and ${behind} commits of their own), so the track starts from \`${MAIN_BRANCH}\`: pull before starting tracks`,
      );
      return main;
    }
    return { ref: upstream, name: shortRef(upstream), notes };
  });

export const trackNew = (
  cwd: string,
  track: string,
  date: string,
  /** The environment for fetching `main`'s upstream: one where git can't prompt. */
  fetchEnv: Readonly<Record<string, string | undefined>>,
  /** When the track starts, recorded so its PRs can be told from an earlier track's of the name. */
  now: Date,
) =>
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
    const start = yield* startPoint(repo, fetchEnv);
    const stub = stubHandoff(track, date, path, start.name);
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

    yield* gitOk(repo, ["worktree", "add", "--quiet", "--no-track", "-b", branch, path, start.ref]);
    yield* gitOk(repo, ["config", STARTED_KEY(track), now.toISOString()]);
    const said = [...start.notes, `created ${path} on \`${branch}\` from \`${start.name}\``];
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

/**
 * Mails a retired handoff Messages section to its track and returns the message id, or the
 * reason it couldn't. Passed in by the CLI, since the mailbox's adapter imports this one.
 */
export type CarryMessages = (
  track: string,
  body: string,
) => Effect.Effect<{ readonly id: string } | { readonly reason: string }>;

/**
 * `handoff` in the older format, upgraded in place (`migrateHandoff`): its Messages go to the
 * track's mailbox first, so nothing is lost if writing fails. Returns the text to parse and
 * what to tell the human; a Messages section that can't be mailed stays, and is said.
 */
const migrate = (track: string, handoff: string, text: string, carry: CarryMessages) =>
  Effect.gen(function* () {
    const migration = migrateHandoff(text);
    if (migration === undefined) return { text, notes: [] };
    const shown = `${HANDOFFS_LINK}/${track}.md`;
    let mailed = "";
    if (migration.carried !== undefined) {
      const sent = yield* carry(track, migration.carried);
      if ("reason" in sent)
        return {
          text,
          notes: [
            `note: ${shown} is in the older format and wasn't migrated: its Messages couldn't be mailed to ${track} (${sent.reason})`,
          ],
        };
      mailed = ` (message ${sent.id})`;
    }
    const temporary = `${handoff}.${process.pid}.tmp`;
    yield* fs("write", temporary, () => writeFile(temporary, migration.text));
    yield* fs("write", handoff, () => rename(temporary, handoff));
    return {
      text: migration.text,
      notes: [`migrated ${shown}: ${migration.changes.join("; ")}${mailed}`],
    };
  });

export const trackList = (cwd: string, carry: CarryMessages) =>
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
    const beads = yield* trackBeads(repo);
    // No git fetch here, so list stays fast (rm fetches before it decides); PRs come from gh.
    const targets = yield* mergeTargets(repo);
    // A label with open beads is a track too, even after its worktree is gone: that work is orphaned.
    const labelled = [...beads.byTrack.keys()];
    const tracks = [...new Set([...byTrack.keys(), ...branches, ...handoffs, ...labelled])]
      .filter((track) => TRACK_NAME.test(track))
      .sort();

    const checkouts = [...byTrack.values()].map((worktree) => worktree.path);
    const present = yield* Effect.filter(checkouts, lexists);
    const notes = yield* ensureHandoffLinks(common, repo, present);
    // list reports, it doesn't gate: a failing bd is a note here, and a refusal in rm.
    if (beads.integration.state === "unavailable" || beads.integration.state === "failed")
      notes.push(`note: open beads not counted: ${beads.integration.reason}`);
    const prs = yield* trackPrs(repo);
    if ("reason" in prs)
      notes.push(`note: PRs not read, so done is unknown where they decide it: ${prs.reason}`);

    const rows = yield* Effect.forEach(tracks, (track) =>
      Effect.gen(function* () {
        const handoff = handoffPath(common, track);
        const found = (yield* lexists(handoff))
          ? yield* fs("read", handoff, () => Bun.file(handoff).text())
          : undefined;
        const migrated =
          found === undefined ? undefined : yield* migrate(track, handoff, found, carry);
        notes.push(...(migrated?.notes ?? []));
        const text = migrated?.text;
        const parsed = text === undefined ? undefined : parseHandoff(text);
        const worktree = byTrack.get(track);
        const branchExists = branches.includes(track);
        const merge = branchExists
          ? yield* mergeState(repo, trackBranch(track), targets)
          : { ahead: undefined, merged: undefined };
        // Only this track's PRs: a reused name mustn't inherit an earlier track's.
        const own = ownPrs(
          "prs" in prs ? prs.prs : undefined,
          track,
          branchExists ? yield* trackStarted(repo, track) : undefined,
        );
        const open =
          beads.integration.state === "ok" ? (beads.byTrack.get(track)?.length ?? 0) : undefined;
        const afterMerge =
          own === undefined || beads.integration.state !== "ok"
            ? []
            : openAfterMerge(own, beads.byId, track);
        const done = trackDone({ beads: open, branchExists, merged: merge.merged, prs: own });
        const lastCommit =
          branchExists && (merge.ahead ?? 0) > 0
            ? (yield* gitOk(repo, ["log", "-1", "--format=%cs", head(trackBranch(track))])) ||
              undefined
            : undefined;
        const row: TrackRow = {
          track,
          status:
            parsed === undefined
              ? "none"
              : "problems" in parsed
                ? "invalid"
                : parsed.stub
                  ? "stub"
                  : "active",
          problems: parsed !== undefined && "problems" in parsed ? parsed.problems : undefined,
          beads: open,
          ...merge,
          done,
          warnings: [
            ...afterMerge,
            ...hygieneWarnings({
              track,
              done,
              stateDate:
                parsed !== undefined && !("problems" in parsed) ? parsed.stateDate : undefined,
              lastCommit,
              hasWorktree: worktree !== undefined,
            }),
          ],
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

/** `*.json` in a directory, or none when it doesn't exist; `.<id>.tmp` files are a send in flight. */
const messageFiles = (dir: string) =>
  Effect.promise(() =>
    readdir(dir).then(
      (files) => files.filter((file) => file.endsWith(".json") && !file.startsWith(".")),
      () => [] as Array<string>,
    ),
  );

/**
 * What `rm` would delete with the track's mailbox. Read here rather than through the mailbox's
 * adapter, which imports this one: the files and their format are `src/core/mail.ts`'s.
 */
const mailboxFacts = (common: string, track: string) =>
  Effect.gen(function* () {
    const path = mailboxDir(common, track);
    const unread = yield* Effect.forEach(yield* messageFiles(path), (file) =>
      Effect.promise(() =>
        readFile(`${path}/${file}`, "utf8").then(
          (text) => {
            const message = decodeMessage(text);
            return typeof message === "string"
              ? `unreadable: ${message}`
              : `from ${message.from}: ${message.subject}`;
          },
          (error) => `unreadable: ${String(error)}`,
        ),
      ).pipe(Effect.map((about) => ({ id: file.slice(0, -".json".length), about }))),
    );
    const facts: MailboxFacts = {
      path,
      exists: yield* lexists(path),
      unread,
      read: (yield* messageFiles(mailboxReadDir(common, track))).length,
    };
    return facts;
  });

/** `say` prints at once: what `--force` will discard is said before it happens. */
/**
 * The track's Claude Code sessions, from the session registry's adapter, which imports this
 * one, so the CLI passes them in. `live` is the running session ids or why they can't be read;
 * `remove` deletes the track's registry and says how many registrations it held.
 */
export interface TrackSessions {
  readonly live: (
    track: string,
  ) => Effect.Effect<{ readonly live: ReadonlyArray<string> } | { readonly unknown: string }>;
  readonly remove: (track: string) => Effect.Effect<number | { readonly unknown: string }>;
}

export const trackRm = (
  cwd: string,
  track: string,
  options: {
    readonly force: boolean;
    readonly keepHandoff: boolean;
    /** Leave the track's open beads labelled for the next track of the same name. */
    readonly keepBeads?: boolean;
    /** The environment for fetching `main`'s upstream: one where git can't prompt. */
    readonly fetchEnv: Readonly<Record<string, string | undefined>>;
    readonly sessions: TrackSessions;
  },
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
    const unfetched = hasBranch ? yield* fetchUpstream(repo, options.fetchEnv) : undefined;
    if (unfetched !== undefined) yield* say(`note: ${unfetched}`);
    const targets = yield* mergeTargets(repo);
    const found = yield* trackBeads(repo);
    // A repo without shape.config.ts gets the default, `optional`; a failing bd refuses either way.
    const setting = yield* loadConfig(repo).pipe(
      Effect.map((config) => config.beads),
      Effect.orElseSucceed(() => "optional" as const),
    );
    const beads: BeadsCheck = {
      integration: found.integration,
      setting,
      open: found.byTrack.get(track) ?? [],
    };
    const mailbox = yield* mailboxFacts(common, track);
    const sessions = yield* options.sessions.live(track);
    const plan = planRm({
      track,
      worktreePath: path,
      worktree,
      pathExists,
      changes,
      statusError: status.code === 0 ? undefined : status.stderr || `exit ${status.code}`,
      branchExists: hasBranch,
      ...(hasBranch
        ? yield* Effect.map(mergeState(repo, branch, targets), (state) => ({
            unmerged: state.ahead,
            merged: state.merged,
          }))
        : { unmerged: 0, merged: true }),
      mergeTargets: targets.map(shortRef),
      branchCheckedOutAt: registered.filter(
        (candidate) => candidate.branch === branch && candidate.path !== path,
      ),
      handoffPath: handoff,
      handoffExists: yield* lexists(handoff),
      beads,
      mailbox,
      sessions,
      force: options.force,
      keepHandoff: options.keepHandoff,
      keepBeads: options.keepBeads ?? false,
    });
    yield* Effect.forEach(plan.notes, (note) => say(`note: ${note}`));
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
          : step.kind === "handoff"
            ? Effect.mapError(
                fs("unlink", step.path, () => unlink(step.path)),
                (error) => new TrackError({ reason: error.message }),
              )
            : Effect.mapError(
                fs("remove", step.path, () => rm(step.path, { recursive: true, force: true })),
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
    // The registry goes last and always: its sessions ran in the worktree just removed.
    const registrations = yield* options.sessions.remove(track);
    if (typeof registrations !== "number")
      yield* say(`note: the session registry of ${track} wasn't removed: ${registrations.unknown}`);
    else if (registrations > 0) removed.push(`${registrations} session registration(s)`);
    return [
      ...removed.map((what) => `removed ${what}`),
      ...plan.kept.map((what) => `kept ${what}`),
    ].join("\n");
  });
