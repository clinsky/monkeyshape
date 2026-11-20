/**
 * Loads the repo's config, `shape.toml`, and decodes it strictly. `shape.config.ts` is refused,
 * to be migrated; `importTsConfig` reads one for `mshape config migrate` alone.
 */

import { join, relative } from "node:path";
import * as Effect from "effect/Effect";
import { settablePrerequisites } from "../core/gate.ts";
import { HARNESSES } from "../harnesses/index.ts";
import { decodeStrict } from "../helpers/decodeStrict.ts";
import { PACKS } from "../packs/index.ts";
import {
  configProblems,
  PACK_IDS,
  type PackId,
  resolveConfig,
  ShapeConfig,
  ShapeToml,
} from "../schemas/config.ts";

/**
 * A listed pack this mshape doesn't ship: the schema knows every pack's id before each pack
 * lands, so a config can name one that would load as nothing and check nothing.
 */
const unshipped = (config: { readonly packs?: ReadonlyArray<string> | undefined }) => {
  const shipped = Object.keys(PACKS);
  return (config.packs ?? [])
    .filter((pack) => !shipped.includes(pack))
    .map(
      (pack) =>
        `packs: lists \`${pack}\`, which this mshape doesn't ship (it ships ${shipped.join(", ")}); run a release that has it, or remove it from \`packs\``,
    );
};

/** A listed harness this mshape doesn't ship, as `unshipped` says of a pack. */
const unshippedHarness = (config: { readonly harnesses?: ReadonlyArray<string> | undefined }) => {
  const shipped = HARNESSES.map((harness) => harness.id);
  return (config.harnesses ?? [])
    .filter((id) => !(shipped as ReadonlyArray<string>).includes(id))
    .map(
      (id) =>
        `harnesses: lists \`${id}\`, which this mshape doesn't ship (it ships ${shipped.join(", ")}); run a release that has it, or remove it from \`harnesses\``,
    );
};

/**
 * A `prerequisites` entry nothing would read: a typo, a tool of a pack the repo doesn't list,
 * or one its pack checks only for itself would otherwise set nothing and say nothing. Read are
 * the listed packs' `tools` (by `mshape check`) and the prerequisite each stage stands for
 * (by `mshape gate`). A config with no `packs` is the TypeScript pack's, as resolved.
 */
const undeclared = (config: {
  readonly packs?: ReadonlyArray<string> | undefined;
  readonly prerequisites?: Readonly<Record<string, unknown>> | undefined;
}) => {
  const listed = config.packs ?? ["typescript"];
  const packs = listed.flatMap((id) => PACKS[id as keyof typeof PACKS] ?? []);
  const declared = packs.flatMap((pack) => pack.prerequisites.map((one) => one.name));
  const read = settablePrerequisites(packs);
  const settable = declared.filter((name) => read.has(name));
  return Object.keys(config.prerequisites ?? {})
    .filter((name) => !read.has(name))
    .map((name) =>
      declared.includes(name)
        ? `prerequisites.${name}: \`${name}\` is a tool its pack checks for itself, and no check or gate stage reads a setting for it, so it can't be made optional here; the ones that can are ${settable.join(", ")}`
        : `prerequisites.${name}: no listed pack (${listed.join(", ")}) has a tool \`${name}\`; the ones that can be set are ${settable.length > 0 ? settable.join(", ") : "none"}`,
    );
};

/** Each shipped pack's default `sources.include`, for a config that sets none. */
const PACK_SOURCES = Object.fromEntries(
  Object.values(PACKS).flatMap((pack) =>
    pack === undefined ? [] : [[pack.id, pack.defaultSources.include] as const],
  ),
);

import { ConfigError } from "../schemas/errors.ts";

export const CONFIG_FILE = "shape.toml";
/** The config as code, which 0.6.0 replaces with `shape.toml`. */
export const TS_CONFIG_FILE = "shape.config.ts";

/** Each pack's mark at the repo root, so a `shape.toml` without `packs` can be told what to list. */
const PACK_MARKERS: ReadonlyArray<readonly [PackId, ReadonlyArray<string>]> = [
  ["typescript", ["tsconfig.json", "package.json"]],
  ["rust", ["Cargo.toml"]],
  ["python", ["pyproject.toml"]],
];

const exists = (path: string) => Effect.promise(() => Bun.file(path).exists());

/**
 * Why importing the config failed, naming where: Bun's build and resolve errors carry the file
 * in `position`, which is often a module the config imports (an adopter rule), not the config.
 */
export const loadFailure = (cause: unknown): string => {
  const causes =
    cause instanceof AggregateError && cause.errors.length > 0 ? cause.errors : [cause];
  return causes
    .map((one: unknown) => {
      const position =
        typeof one === "object" && one !== null && "position" in one
          ? (one.position as { file?: unknown; line?: unknown; column?: unknown } | null)
          : null;
      const where =
        typeof position?.file === "string" && position.file !== ""
          ? `${position.file}${typeof position.line === "number" ? `:${position.line}` : ""}${typeof position.column === "number" ? `:${position.column}` : ""}: `
          : "";
      return `${where}${String(one)}`;
    })
    .join("; ");
};

/** What a repo with only `shape.config.ts` is told: mshape reads `shape.toml` alone. */
/**
 * How to migrate, as commands that run: `config migrate` imports `shape.config.ts`, whose
 * imports resolve only under the npm package, so it runs through that, not an installed mshape.
 */
export const MIGRATE_STEPS = `run \`bun add -d --exact monkeyshape\` (a release with \`config migrate\`), then \`bun run --silent mshape config migrate\`, which writes ${CONFIG_FILE} with the same values and deletes ${TS_CONFIG_FILE}`;

const MIGRATE = `this mshape reads ${CONFIG_FILE} only, not a config as code: ${MIGRATE_STEPS}`;

/** The repo's own config, `shape.toml`; `shape.config.ts` is refused, to be migrated. */
export const findConfig = (root: string) =>
  Effect.gen(function* () {
    const toml = yield* exists(join(root, CONFIG_FILE));
    const ts = yield* exists(join(root, TS_CONFIG_FILE));
    if (toml && ts)
      return yield* Effect.fail(
        new ConfigError({
          path: CONFIG_FILE,
          reason: `${TS_CONFIG_FILE} is here too, and a repo has one config: keep ${CONFIG_FILE}, move into it anything only ${TS_CONFIG_FILE} says, and delete ${TS_CONFIG_FILE}`,
        }),
      );
    if (ts) return yield* Effect.fail(new ConfigError({ path: TS_CONFIG_FILE, reason: MIGRATE }));
    return toml ? join(root, CONFIG_FILE) : undefined;
  });

const loadToml = (root: string, path: string, shown: string) =>
  Effect.gen(function* () {
    const text = yield* Effect.promise(() => Bun.file(path).text());
    const parsed = yield* Effect.try({
      try: (): unknown => Bun.TOML.parse(text),
      catch: (cause) =>
        new ConfigError({
          path: shown,
          reason: `isn't valid TOML: ${cause instanceof Error ? cause.message : String(cause)}`,
        }),
    });
    const config = yield* decodeStrict(ShapeToml)(parsed).pipe(
      Effect.mapError((error) => new ConfigError({ path: shown, reason: error.message })),
    );
    if (config.packs === undefined) {
      const found: Array<PackId> = [];
      for (const [pack, markers] of PACK_MARKERS)
        for (const marker of markers)
          if (!found.includes(pack) && (yield* exists(join(root, marker)))) found.push(pack);
      return yield* Effect.fail(
        new ConfigError({
          path: shown,
          reason:
            found.length > 0
              ? `has no \`packs\`: this repo has ${found.map((pack) => `${pack}'s files`).join(" and ")}, so add \`packs = [${found.map((pack) => `"${pack}"`).join(", ")}]\` at the top, in the order their gate stages should run`
              : `has no \`packs\`: add \`packs = ["<pack>"]\` at the top, naming the languages this repo is written in (${PACK_IDS.join(", ")})`,
        }),
      );
    }
    const problems = [
      ...configProblems(config),
      ...unshipped(config),
      ...unshippedHarness(config),
      ...undeclared(config),
    ];
    if (problems.length > 0)
      return yield* Effect.fail(new ConfigError({ path: shown, reason: problems.join("; ") }));
    return resolveConfig(config, shown, [], PACK_SOURCES);
  });

/**
 * `shape.config.ts` (or a `--config` module) imported and decoded strictly, before any of the
 * checks across keys: what `config migrate` turns into `shape.toml`. `shown` names it in errors.
 */
export const importTsConfig = (_root: string, path: string, shown: string) =>
  Effect.gen(function* () {
    const module = yield* Effect.tryPromise({
      try: async () => (await import(path)) as { readonly default?: unknown },
      catch: (cause) =>
        new ConfigError({
          path: shown,
          reason: `could not load: ${cause instanceof Error && !("position" in cause) ? cause.message : loadFailure(cause)}`,
        }),
    });
    return yield* decodeStrict(ShapeConfig)(module.default).pipe(
      Effect.mapError((error) => new ConfigError({ path: shown, reason: error.message })),
    );
  });

/**
 * What a decoded `shape.config.ts` would have been refused for when mshape still read one:
 * migrate refuses such a config before writing anything, to be fixed where it was written.
 */
export const tsConfigProblems = (config: ShapeConfig): ReadonlyArray<string> => [
  ...configProblems(config),
  ...unshipped(config),
  ...unshippedHarness(config),
  ...undeclared(config),
];

/**
 * `path` overrides the repo's own config, e.g. to try monkeyshape on a repo before adopting
 * it: a `.toml` file is read as `shape.toml`, anything else imported as `shape.config.ts`.
 */
export const loadConfig = (root: string, given?: string) =>
  Effect.gen(function* () {
    const path = given ?? (yield* findConfig(root)) ?? join(root, CONFIG_FILE);
    // The file tried, as the user would name it: `--config` may point anywhere.
    const shown = relative(root, path).startsWith("..") ? path : relative(root, path);
    const own = given === undefined;
    if (!(yield* exists(path)))
      return yield* Effect.fail(
        new ConfigError({
          path: shown,
          reason: own ? "not found; every adopting repo has one" : "not found",
        }),
      );
    if (path.endsWith(".toml")) return yield* loadToml(root, path, shown);
    // shape.toml alone: a TypeScript config is refused wherever it is, --config's included.
    return yield* Effect.fail(new ConfigError({ path: shown, reason: MIGRATE }));
  });
