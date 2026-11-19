/**
 * `mshape config migrate`: imports `shape.config.ts`, writes what `planMigration` decides as
 * `shape.toml`, and deletes the old file. Every refusal comes before anything is written, and
 * the new config is loaded as `mshape` will load it before it replaces the old one.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { planMigration } from "../core/migrate.ts";
import { SHAPE_RULES_DIR } from "../core/rules/shapeRules.ts";
import type { BornPin } from "../core/scaffold.ts";
import {
  CONFIG_FILE,
  importTsConfig,
  loadConfig,
  MIGRATE_STEPS,
  TS_CONFIG_FILE,
  tsConfigProblems,
} from "./config.ts";
import { runningCompiled } from "./launch.ts";

const exists = (path: string) => Effect.promise(() => Bun.file(path).exists());

/**
 * The monkeyshape the repo's `node_modules` holds, which the pin must equal (the sync check's
 * `pin-npm-differs`); undefined where none is installed.
 */
const installedVersion = (root: string) =>
  Effect.promise(async () => {
    const manifest: unknown = await Bun.file(
      join(root, "node_modules", "monkeyshape", "package.json"),
    )
      .json()
      .catch(() => undefined);
    return typeof manifest === "object" &&
      manifest !== null &&
      "version" in manifest &&
      typeof manifest.version === "string"
      ? manifest.version
      : undefined;
  });

/** The repo's Markdown that names `shape.config.ts`, which migrate deletes: refs flags each. */
const docsNaming = (root: string) =>
  Effect.promise(async () => {
    const found: Array<string> = [];
    for await (const file of new Bun.Glob("**/*.md").scan({ cwd: root, dot: false }))
      if (
        !file.startsWith("node_modules/") &&
        (await Bun.file(join(root, file)).text()).includes(TS_CONFIG_FILE)
      )
        found.push(file);
    return found.sort();
  });

/** Whether an import failed for want of the `monkeyshape` package, not for the config itself. */
export const npmPackageMissing = (message: string): boolean =>
  /Cannot find (?:package|module) ['"]monkeyshape['"]/u.test(message);

/** A local rule's id, as `defineRule` gives it; a rule with none is named by its place. */
const ruleId = (rule: unknown, index: number): string =>
  typeof rule === "object" && rule !== null && "id" in rule && typeof rule.id === "string"
    ? rule.id
    : `localRules[${index}] (a rule with no id)`;

export interface MigrateResult {
  readonly lines: ReadonlyArray<string>;
  /** 0 migrated; 1 refused, with nothing changed. */
  readonly code: number;
}

/**
 * Migrates `root`'s `shape.config.ts` to `shape.toml`, pinning `pin`. `load` reads a config as
 * `mshape` will, `loadConfig` but for tests that need it to fail.
 */
export const migrateConfig = (
  root: string,
  pin: BornPin,
  load: typeof loadConfig = loadConfig,
  /** Whether this is the compiled mshape, which can't import a TypeScript config. */
  compiled: boolean = runningCompiled(),
) =>
  Effect.gen(function* () {
    const refuse = (line: string): MigrateResult => ({ lines: [line], code: 1 });
    // shape.config.ts imports `monkeyshape`, which resolves only under the npm package.
    if (compiled)
      return refuse(
        `config migrate imports ${TS_CONFIG_FILE}, whose imports resolve only under monkeyshape's npm package, not an installed mshape: ${MIGRATE_STEPS}. Nothing was changed`,
      );
    if (yield* exists(join(root, CONFIG_FILE)))
      return refuse(
        `${CONFIG_FILE} is already here, so this repo is migrated: nothing was changed. Edit ${CONFIG_FILE}${(yield* exists(join(root, TS_CONFIG_FILE))) ? `, and delete ${TS_CONFIG_FILE}, which mshape no longer reads` : ""}`,
      );
    const path = join(root, TS_CONFIG_FILE);
    if (!(yield* exists(path)))
      return refuse(
        `there is no ${TS_CONFIG_FILE} here to migrate. Run mshape config migrate at the root of a repo that has one; a new repo gets ${CONFIG_FILE} from mshape init`,
      );
    // The old config as mshape loaded it: one it refused is fixed first, in the language its
    // author wrote, rather than carried into shape.toml.
    const imported = yield* Effect.result(importTsConfig(root, path, TS_CONFIG_FILE));
    if (imported._tag === "Failure")
      return refuse(
        npmPackageMissing(imported.failure.message)
          ? `${TS_CONFIG_FILE} imports monkeyshape, which this repo doesn't install: ${MIGRATE_STEPS}. Nothing was changed`
          : `${imported.failure.message}; nothing was changed. Fix it, then run mshape config migrate again`,
      );
    const config = imported.success;
    const problems = tsConfigProblems(config);
    if (problems.length > 0)
      return refuse(
        `${TS_CONFIG_FILE} doesn't load today (${TS_CONFIG_FILE}: ${problems.join("; ")}), so nothing was changed. Fix it, then run mshape config migrate again`,
      );
    const source = yield* Effect.promise(() => Bun.file(path).text());
    const ruleIds = (config.localRules ?? []).map(ruleId);
    const ported = new Set<string>();
    for (const id of ruleIds)
      if (yield* exists(join(root, SHAPE_RULES_DIR, `${id}.yml`))) ported.add(id);
    // The pin is the monkeyshape the repo installs, so mshape and its imports are one version.
    const installed = yield* installedVersion(root);
    const plan = planMigration({
      config,
      source,
      ruleIds,
      ported,
      pin: installed === undefined ? pin : { version: installed },
    });
    if ("refused" in plan) return { lines: plan.refused, code: 1 } satisfies MigrateResult;
    // Loaded as mshape will load it, from beside the repo, before it replaces anything: a
    // failure leaves shape.config.ts as it was and writes no shape.toml into the repo.
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-migrate-")));
    const loaded = yield* Effect.gen(function* () {
      const trial = join(dir, CONFIG_FILE);
      yield* Effect.promise(() => writeFile(trial, plan.toml));
      return yield* Effect.result(load(root, trial));
    }).pipe(Effect.ensuring(Effect.promise(() => rm(dir, { recursive: true, force: true }))));
    if (loaded._tag === "Failure")
      return refuse(
        `the ${CONFIG_FILE} written from ${TS_CONFIG_FILE} doesn't load (${loaded.failure.message}), so nothing was changed. This is a bug in mshape config migrate: report it with your ${TS_CONFIG_FILE}`,
      );
    yield* Effect.promise(async () => {
      await writeFile(join(root, CONFIG_FILE), plan.toml);
      await rm(path);
    });
    const stale = yield* docsNaming(root);
    return {
      lines: [
        `wrote ${CONFIG_FILE} from ${TS_CONFIG_FILE}, and deleted ${TS_CONFIG_FILE}`,
        ...plan.notes.map((note) => `note: ${note}`),
        ...(stale.length === 0
          ? []
          : [
              `note: ${stale.join(", ")} ${stale.length === 1 ? "names" : "name"} ${TS_CONFIG_FILE}, which is gone: say ${CONFIG_FILE} there (refs/missing-path flags each until then)`,
            ]),
        `run mshape check: it gives the same outcomes as before, now read from ${CONFIG_FILE}`,
      ],
      code: 0,
    } satisfies MigrateResult;
  });
