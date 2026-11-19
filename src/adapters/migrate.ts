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
import { CONFIG_FILE, importTsConfig, loadConfig, TS_CONFIG_FILE } from "./config.ts";

const exists = (path: string) => Effect.promise(() => Bun.file(path).exists());

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

/** Migrates `root`'s `shape.config.ts` to `shape.toml`, pinning `pin`. */
export const migrateConfig = (root: string, pin: BornPin) =>
  Effect.gen(function* () {
    const refuse = (line: string): MigrateResult => ({ lines: [line], code: 1 });
    if (yield* exists(join(root, CONFIG_FILE)))
      return refuse(
        `${CONFIG_FILE} is already here, so this repo is migrated: nothing was changed. Edit ${CONFIG_FILE}${(yield* exists(join(root, TS_CONFIG_FILE))) ? `, and delete ${TS_CONFIG_FILE}, which mshape no longer reads` : ""}`,
      );
    const path = join(root, TS_CONFIG_FILE);
    if (!(yield* exists(path)))
      return refuse(
        `there is no ${TS_CONFIG_FILE} here to migrate. Run mshape config migrate at the root of a repo that has one; a new repo gets ${CONFIG_FILE} from mshape init`,
      );
    const config = yield* importTsConfig(root, path, TS_CONFIG_FILE);
    const source = yield* Effect.promise(() => Bun.file(path).text());
    const ruleIds = (config.localRules ?? []).map(ruleId);
    const ported = new Set<string>();
    for (const id of ruleIds)
      if (yield* exists(join(root, SHAPE_RULES_DIR, `${id}.yml`))) ported.add(id);
    const plan = planMigration({ config, source, ruleIds, ported, pin });
    if ("refused" in plan) return { lines: plan.refused, code: 1 } satisfies MigrateResult;
    // Loaded as mshape will load it, from beside the repo, before it replaces anything.
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-migrate-")));
    const loaded = yield* Effect.gen(function* () {
      const trial = join(dir, CONFIG_FILE);
      yield* Effect.promise(() => writeFile(trial, plan.toml));
      return yield* Effect.result(loadConfig(root, trial));
    }).pipe(Effect.ensuring(Effect.promise(() => rm(dir, { recursive: true, force: true }))));
    if (loaded._tag === "Failure")
      return refuse(
        `the ${CONFIG_FILE} written from ${TS_CONFIG_FILE} doesn't load (${loaded.failure.message}), so nothing was changed. This is a bug in mshape config migrate: report it with your ${TS_CONFIG_FILE}`,
      );
    yield* Effect.promise(async () => {
      await writeFile(join(root, CONFIG_FILE), plan.toml);
      await rm(path);
    });
    return {
      lines: [
        `wrote ${CONFIG_FILE} from ${TS_CONFIG_FILE}, and deleted ${TS_CONFIG_FILE}`,
        ...plan.notes.map((note) => `note: ${note}`),
        `run mshape check: it gives the same outcomes as before, now read from ${CONFIG_FILE}`,
      ],
      code: 0,
    } satisfies MigrateResult;
  });
