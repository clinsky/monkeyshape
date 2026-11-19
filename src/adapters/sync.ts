/**
 * `mshape sync`'s writes: PRIME.md, the PR template and each listed harness's files, as
 * `planSync` decides.
 */
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import * as Effect from "effect/Effect";
import { PR_TEMPLATE_FILE, PRIME_FILE } from "../core/conventions.ts";
import { type Delivery, deliveries, shippedFiles } from "../core/delivery.ts";
import { SKILLS_DIR, SKILLS_MANIFEST } from "../core/layout.ts";
import { ownedFiles, parseManifest, skillsLinkOf } from "../core/skills.ts";
import {
  harnessDeliveries,
  harnessPaths,
  isPrTemplate,
  planSync,
  SYNCED_FILES,
  type SyncPlan,
} from "../core/sync.ts";
import type { Harness } from "../harnesses/harness.ts";
import { HARNESSES } from "../harnesses/index.ts";
import { PACKS } from "../packs/index.ts";
import type { HarnessId } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { loadConfig } from "./config.ts";
import { readPresent } from "./disk.ts";
import { installSkills } from "./skills.ts";

const text = (path: string): Promise<string | undefined> =>
  Bun.file(path)
    .text()
    .catch(() => undefined);

/**
 * The synced files on disk that git ignores: the same files `mshape check` sees as present but
 * unlisted, so check and sync agree on them. Outside a git repository, none.
 */
const ignoredFiles = async (
  repo: string,
  harnessFiles: ReadonlyArray<string>,
): Promise<ReadonlyArray<string>> => {
  const out: Array<string> = [];
  for (const file of [...SYNCED_FILES, ...harnessFiles]) {
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

/** Each delivered config with its file's text now, read one by one: a pack has a few. */
const currentTexts = async (repo: string, delivered: ReadonlyArray<Delivery>) => {
  const out: Array<{ delivery: Delivery; current: string | undefined }> = [];
  for (const delivery of delivered)
    out.push({ delivery, current: await text(`${repo}/${delivery.file}`) });
  return out;
};

/**
 * Brings `repo`'s synced files up to the package at `packageRoot`, taking over the adopter's
 * own files in `replace`. Run it before the skills' install, which records `plan.owned`: an
 * unreadable manifest stops both before anything is written.
 */
/**
 * The harnesses sync delivers for: the shipped ones, and which the repo lists. Undefined when
 * the repo's config doesn't load, so sync touches no harness's file on a guess.
 */
export interface HarnessSelection {
  readonly shipped: ReadonlyArray<Harness>;
  readonly listed: ReadonlyArray<HarnessId>;
}

export const syncRepo = (
  repo: string,
  packageRoot: string,
  replace: ReadonlyArray<string> = [],
  delivered: ReadonlyArray<Delivery> = [],
  harnesses: HarnessSelection | undefined = { shipped: HARNESSES, listed: ["claude-code"] },
) =>
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
      const texts = new Map<string, string | undefined>();
      for (const path of harnessPaths(harnesses?.shipped ?? []))
        texts.set(path, await text(`${repo}/${path}`));
      const harnessFiles =
        harnesses === undefined
          ? []
          : harnessDeliveries(harnesses.shipped, harnesses.listed, (path) => texts.get(path));
      const plan = planSync(
        {
          ignored: await ignoredFiles(
            repo,
            harnessFiles.filter((one) => one.listed).map((one) => one.file.path),
          ),
          beads: await stat(`${repo}/.beads`).then(
            (found) => found.isDirectory(),
            () => false,
          ),
          prime: await text(`${repo}/${PRIME_FILE}`),
          prTemplate: await text(`${repo}/${PR_TEMPLATE_FILE}`),
          harnessFiles,
          owned: ownedFiles(manifest),
          replace,
          otherTemplates: await otherTemplates(repo),
          deliveries: await currentTexts(repo, delivered),
        },
        shipped,
      );
      for (const [path, contents] of plan.write) {
        await mkdir(dirname(`${repo}/${path}`), { recursive: true });
        await Bun.write(`${repo}/${path}`, contents);
      }
      for (const path of plan.remove) await rm(`${repo}/${path}`, { force: true });
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
/**
 * The repo's listed packs' `copy` and `table` configs, from its config. A repo whose config
 * doesn't load has none to deliver: sync still brings the loop's files up to date, and
 * `mshape check` reports the config.
 */
export const packDeliveries = (repo: string, packageRoot: string) =>
  Effect.gen(function* () {
    const config = yield* Effect.option(loadConfig(repo));
    if (config._tag === "None") return [];
    const packs = config.value.packs.flatMap((id) => {
      const pack = PACKS[id];
      return pack === undefined ? [] : [pack];
    });
    const shipped = yield* readPresent(packageRoot, shippedFiles(packs));
    return deliveries(config.value, packs, shipped);
  });

/** The repo's listed harnesses, from its config; undefined when the config doesn't load. */
export const harnessSelection = (repo: string) =>
  Effect.map(Effect.option(loadConfig(repo)), (config) =>
    config._tag === "None"
      ? undefined
      : ({ shipped: HARNESSES, listed: config.value.harnesses } satisfies HarnessSelection),
  );

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
    const selection = yield* harnessSelection(repo);
    const plan = yield* syncRepo(
      repo,
      packageRoot,
      replace.files,
      yield* packDeliveries(repo, packageRoot),
      selection,
    );
    const skills = yield* installSkills(
      `${packageRoot}/skills`,
      repo,
      { files: plan.owned, replace: replace.skills },
      selection === undefined ? undefined : skillsLinkOf(selection.shipped, selection.listed),
    );
    return { plan, skills };
  });
