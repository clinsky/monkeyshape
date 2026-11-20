/** Installs the package's shared skills into a repo, and links them where a harness looks. */
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { SKILLS_DIR, SKILLS_MANIFEST } from "../core/layout.ts";
import type { SkillFiles, SkillsLink, SkillsSnapshot } from "../core/model.ts";
import {
  parseManifest,
  type SkillSync,
  type SkillSyncOptions,
  skillsLinkOf,
  syncSkills,
} from "../core/skills.ts";
import { HARNESSES } from "../harnesses/index.ts";
import { DEFAULT_HARNESSES } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";

/**
 * Where a repo that lists no `harnesses` has its link. `at` is never defaulted: an explicit
 * undefined (no listed harness reads skills through a link) must not become this one.
 */
export const DEFAULT_LINK = skillsLinkOf(HARNESSES, DEFAULT_HARNESSES);

/** Whether anything is at `path`, a dangling link included. */
const present = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/**
 * Every file under `dir` as bytes, by relative path; a missing directory has none. Symlinks
 * are followed, so a skill linked in from elsewhere is read like any other.
 */
export const readTree = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const files = new Map<string, Uint8Array>();
      if (!(await present(dir))) return files as SkillFiles;
      const glob = new Bun.Glob("**").scan({ cwd: dir, dot: true, followSymlinks: true });
      for await (const path of glob) files.set(path, await Bun.file(`${dir}/${path}`).bytes());
      return files as SkillFiles;
    },
    catch: (cause) => new WorkspaceError({ operation: "read", path: dir, reason: String(cause) }),
  });

export interface SkillsInstall {
  readonly sync: SkillSync;
  /** The link sync created, where a listed harness reads skills through one. */
  readonly linked: string | undefined;
  /** The links sync removed: made for a harness no longer listed, and still as made. */
  readonly unlinked: ReadonlyArray<string>;
}

/** The links of `unlisted` still exactly as monkeyshape made them. */
const strays = async (
  repo: string,
  unlisted: ReadonlyArray<NonNullable<SkillsSnapshot["linkAt"]>>,
) => {
  const out: Array<NonNullable<SkillsSnapshot["linkAt"]>> = [];
  for (const one of unlisted) {
    const link = await linkAt(`${repo}/${one.path}`);
    if (link.kind === "link" && link.target === one.target) out.push(one);
  }
  return out;
};

/**
 * Brings `<repo>/.agents/skills` up to the package's `skills/`, and creates the
 * `.claude/skills` link if it is missing. An existing link or directory there is left alone:
 * `mshape check` says what is wrong with it.
 */
export const installSkills = (
  shippedDir: string,
  repo: string,
  options: SkillSyncOptions,
  /** Where a listed harness reads skills through a link; undefined when none does. */
  at: SkillsSnapshot["linkAt"],
  unlisted: ReadonlyArray<NonNullable<SkillsSnapshot["linkAt"]>> = [],
) =>
  Effect.gen(function* () {
    const installedDir = `${repo}/${SKILLS_DIR}`;
    const installed = yield* readTree(installedDir);
    const manifest = installed.get(SKILLS_MANIFEST);
    // An unreadable manifest can't tell shared skills from the repo's own: touch nothing.
    if (manifest !== undefined && parseManifest(manifest) === undefined)
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "sync skills",
          path: `${SKILLS_DIR}/${SKILLS_MANIFEST}`,
          reason: `is not the list sync writes, so nothing was changed. Restore it with \`git checkout -- ${SKILLS_DIR}/${SKILLS_MANIFEST}\``,
        }),
      );
    const sync = syncSkills(yield* readTree(shippedDir), installed, options);
    const link = at === undefined ? undefined : `${repo}/${at.path}`;
    const unlinked: Array<string> = [];
    const linked = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(installedDir, { recursive: true });
        for (const path of sync.remove) await rm(`${installedDir}/${path}`);
        for (const skill of sync.retired) {
          const target = resolve(installedDir, skill);
          // Belt and braces: syncSkills only retires installed skill directories.
          if (dirname(target) !== resolve(installedDir))
            throw new Error(`refusing to remove ${target}: not a skill directory`);
          await rm(target, { recursive: true });
        }
        for (const [path, bytes] of sync.write) {
          await mkdir(dirname(`${installedDir}/${path}`), { recursive: true });
          await Bun.write(`${installedDir}/${path}`, bytes);
        }
        for (const stray of await strays(repo, unlisted)) {
          await rm(`${repo}/${stray.path}`);
          unlinked.push(stray.path);
        }
        if (at === undefined || link === undefined || (await present(link))) return undefined;
        await mkdir(dirname(link), { recursive: true });
        await symlink(at.target, link);
        return at.path;
      },
      catch: (cause) =>
        new WorkspaceError({ operation: "install skills", path: repo, reason: String(cause) }),
    });
    return { sync, linked, unlinked } satisfies SkillsInstall;
  });

const linkAt = (path: string): Promise<SkillsLink> =>
  lstat(path).then(
    async (info): Promise<SkillsLink> =>
      info.isSymbolicLink()
        ? { kind: "link", target: await readlink(path) }
        : info.isDirectory()
          ? { kind: "directory" }
          : { kind: "other" },
    (): SkillsLink => ({ kind: "missing" }),
  );

/** What `mshape check` needs to verify the install, read from disk as agents will see it. */
export const loadSkills = (
  shippedDir: string,
  repo: string,
  /** Where a listed harness reads skills through a link; undefined when none does. */
  at: SkillsSnapshot["linkAt"],
  unlisted: ReadonlyArray<NonNullable<SkillsSnapshot["linkAt"]>> = [],
) =>
  Effect.gen(function* () {
    const stray = yield* Effect.promise(() => strays(repo, unlisted));
    const link: SkillsLink =
      at === undefined
        ? { kind: "missing" }
        : yield* Effect.promise(() => linkAt(`${repo}/${at.path}`));
    return {
      ...(at === undefined ? {} : { linkAt: at }),
      ...(stray.length === 0
        ? {}
        : { strayLinks: stray.map(({ path, harness }) => ({ path, harness })) }),
      link,
      installed: yield* readTree(`${repo}/${SKILLS_DIR}`),
      claudeDirectory:
        at !== undefined && link.kind === "directory"
          ? yield* readTree(`${repo}/${at.path}`)
          : new Map(),
      shipped: yield* readTree(shippedDir),
    } satisfies SkillsSnapshot;
  });
