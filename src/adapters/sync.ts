/** `mshape sync`'s writes: PRIME.md, the PR template and the hooks, as `planSync` decides. */
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { Effect } from "effect";
import { PR_TEMPLATE_FILE, PRIME_FILE } from "../core/conventions.ts";
import { SETTINGS_FILE } from "../core/hooks.ts";
import { SKILLS_DIR, SKILLS_MANIFEST } from "../core/layout.ts";
import { ownedFiles, parseManifest } from "../core/skills.ts";
import { isPrTemplate, planSync, SYNCED_FILES, type SyncPlan } from "../core/sync.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { installSkills } from "./skills.ts";

const text = (path: string): Promise<string | undefined> =>
  Bun.file(path)
    .text()
    .catch(() => undefined);

/**
 * The synced files on disk that git ignores: the same files `mshape check` sees as present but
 * unlisted, so check and sync agree on them. Outside a git repository, none.
 */
const ignoredFiles = async (repo: string): Promise<ReadonlyArray<string>> => {
  const out: Array<string> = [];
  for (const file of SYNCED_FILES) {
    if (!(await Bun.file(`${repo}/${file}`).exists())) continue;
    const ran = Bun.spawnSync(["git", "check-ignore", "--quiet", "--", file], { cwd: repo });
    if (ran.exitCode === 0) out.push(file);
  }
  return out;
};

/** The PR templates GitHub would read in `repo` besides sync's, by their names on disk. */
const otherTemplates = async (repo: string): Promise<ReadonlyArray<string>> => {
  const out: Array<string> = [];
  for (const dir of ["", ".github/", "docs/"]) {
    const entries = await readdir(`${repo}/${dir}`, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = `${dir}${entry.name}`;
      if (entry.isFile() && path !== PR_TEMPLATE_FILE && isPrTemplate(path)) out.push(path);
    }
  }
  return out.sort();
};

/**
 * Brings `repo`'s synced files up to the package at `packageRoot`, taking over the adopter's
 * own files in `replace`. Run it before the skills' install, which records `plan.owned`: an
 * unreadable manifest stops both before anything is written.
 */
export const syncRepo = (repo: string, packageRoot: string, replace: ReadonlyArray<string> = []) =>
  Effect.tryPromise({
    try: async (): Promise<SyncPlan> => {
      const shipped = await text(`${packageRoot}/template/${PRIME_FILE}`);
      if (shipped === undefined)
        throw new Error(`${packageRoot} ships no template/${PRIME_FILE}; reinstall monkeyshape`);
      const manifestFile = Bun.file(`${repo}/${SKILLS_DIR}/${SKILLS_MANIFEST}`);
      const manifest = (await manifestFile.exists()) ? await manifestFile.bytes() : undefined;
      if (manifest !== undefined && parseManifest(manifest) === undefined)
        throw new Error(
          `${SKILLS_DIR}/${SKILLS_MANIFEST} is not the list sync writes, so nothing was changed. Restore it with \`git checkout -- ${SKILLS_DIR}/${SKILLS_MANIFEST}\``,
        );
      const plan = planSync(
        {
          ignored: await ignoredFiles(repo),
          beads: await stat(`${repo}/.beads`).then(
            (found) => found.isDirectory(),
            () => false,
          ),
          prime: await text(`${repo}/${PRIME_FILE}`),
          prTemplate: await text(`${repo}/${PR_TEMPLATE_FILE}`),
          settings: await text(`${repo}/${SETTINGS_FILE}`),
          owned: ownedFiles(manifest),
          replace,
          otherTemplates: await otherTemplates(repo),
        },
        shipped,
      );
      for (const [path, contents] of plan.write) {
        await mkdir(dirname(`${repo}/${path}`), { recursive: true });
        await Bun.write(`${repo}/${path}`, contents);
      }
      return plan;
    },
    catch: (cause) =>
      new WorkspaceError({
        operation: "sync",
        path: repo,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });

export interface SyncReplace {
  /** Files of `OWNABLE_FILES` to take over. */
  readonly files: ReadonlyArray<string>;
  /** Skills of the repo's own to replace with the shared skill of the same name. */
  readonly skills: ReadonlyArray<string>;
}

/** `mshape sync`: the files and hooks, then the skills and the manifest recording both. */
export const syncAll = (
  repo: string,
  packageRoot: string,
  replace: SyncReplace = { files: [], skills: [] },
) =>
  Effect.gen(function* () {
    const shipped = yield* Effect.promise(() =>
      readdir(`${packageRoot}/skills`, { withFileTypes: true }).catch(() => []),
    );
    const names = new Set(shipped.filter((entry) => !entry.isFile()).map((entry) => entry.name));
    const unknown = replace.skills.filter((skill) => !names.has(skill));
    // Before anything is written: a typo must not look as if it took effect.
    if (unknown.length > 0)
      return yield* Effect.fail(
        new WorkspaceError({
          operation: "sync --replace",
          path: unknown.map((skill) => `${SKILLS_DIR}/${skill}`).join(", "),
          reason: `monkeyshape ships no skill of that name, so there is nothing to replace it with. It ships ${[...names].sort().join(", ")}`,
        }),
      );
    const plan = yield* syncRepo(repo, packageRoot, replace.files);
    const skills = yield* installSkills(`${packageRoot}/skills`, repo, {
      files: plan.owned,
      replace: replace.skills,
    });
    return { plan, skills };
  });
