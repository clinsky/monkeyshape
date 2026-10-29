/** Installs the package's shared skills into a repo, and links them where Claude Code looks. */
import { lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import type { SkillFiles, SkillsLink, SkillsSnapshot } from "../core/model.ts";
import {
  CLAUDE_SKILLS_LINK,
  CLAUDE_SKILLS_TARGET,
  SKILLS_DIR,
  type SkillSync,
  syncSkills,
} from "../core/skills.ts";
import { WorkspaceError } from "../schemas/errors.ts";

/** Whether anything is at `path`, a dangling link included. */
const present = (path: string): Promise<boolean> =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Every file under `dir`, by relative path; a missing directory has none. */
export const readTree = (dir: string) =>
  Effect.tryPromise({
    try: async () => {
      const files = new Map<string, string>();
      if (!(await present(dir))) return files;
      for await (const path of new Bun.Glob("**").scan({ cwd: dir, dot: true }))
        files.set(path, await Bun.file(`${dir}/${path}`).text());
      return files as SkillFiles;
    },
    catch: (cause) => new WorkspaceError({ operation: "read", path: dir, reason: String(cause) }),
  });

export interface SkillsInstall {
  readonly sync: SkillSync;
  /** Whether `.claude/skills` had to be created. */
  readonly linked: boolean;
}

/**
 * Brings `<repo>/.agents/skills` up to the package's `skills/`, and creates the
 * `.claude/skills` link if it is missing. An existing link or directory there is left alone:
 * `mshape check` says what is wrong with it.
 */
export const installSkills = (shippedDir: string, repo: string) =>
  Effect.gen(function* () {
    const installedDir = `${repo}/${SKILLS_DIR}`;
    const sync = syncSkills(yield* readTree(shippedDir), yield* readTree(installedDir));
    const link = `${repo}/${CLAUDE_SKILLS_LINK}`;
    const linked = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(installedDir, { recursive: true });
        for (const path of sync.remove) await rm(`${installedDir}/${path}`);
        for (const [path, text] of sync.write) {
          await mkdir(dirname(`${installedDir}/${path}`), { recursive: true });
          await Bun.write(`${installedDir}/${path}`, text);
        }
        if (await present(link)) return false;
        await mkdir(dirname(link), { recursive: true });
        await symlink(CLAUDE_SKILLS_TARGET, link);
        return true;
      },
      catch: (cause) =>
        new WorkspaceError({ operation: "install skills", path: repo, reason: String(cause) }),
    });
    return { sync, linked } satisfies SkillsInstall;
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
export const loadSkills = (shippedDir: string, repo: string) =>
  Effect.gen(function* () {
    const link = yield* Effect.promise(() => linkAt(`${repo}/${CLAUDE_SKILLS_LINK}`));
    return {
      link,
      installed: yield* readTree(`${repo}/${SKILLS_DIR}`),
      claudeDirectory:
        link.kind === "directory" ? yield* readTree(`${repo}/${CLAUDE_SKILLS_LINK}`) : new Map(),
      shipped: yield* readTree(shippedDir),
    } satisfies SkillsSnapshot;
  });
