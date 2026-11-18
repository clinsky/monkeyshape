/**
 * Loads the repo's config, `shape.toml`, and decodes it strictly. `shape.config.ts` still
 * loads, by importing it, until `mshape config migrate` replaces it.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import * as Effect from "effect/Effect";
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

/**
 * A `prerequisites` entry no listed pack declares: a typo, or a tool of a pack the repo doesn't
 * list, would otherwise set nothing and say nothing. A config with no `packs` is the
 * TypeScript pack's, as the resolved config is.
 */
const undeclared = (config: {
  readonly packs?: ReadonlyArray<string> | undefined;
  readonly prerequisites?: Readonly<Record<string, unknown>> | undefined;
}) => {
  const listed = config.packs ?? ["typescript"];
  const declared = listed.flatMap(
    (id) => PACKS[id as keyof typeof PACKS]?.prerequisites.map((one) => one.name) ?? [],
  );
  return Object.keys(config.prerequisites ?? {})
    .filter((name) => !declared.includes(name))
    .map(
      (name) =>
        `prerequisites.${name}: no listed pack (${listed.join(", ")}) has a tool \`${name}\`; ${declared.length > 0 ? `the ones they have are ${declared.join(", ")}` : "they declare none"}`,
    );
};

/** Each shipped pack's default `sources.include`, for a config that sets none. */
const PACK_SOURCES = Object.fromEntries(
  Object.values(PACKS).flatMap((pack) =>
    pack === undefined ? [] : [[pack.id, pack.defaultSources.include] as const],
  ),
);

import { ConfigError } from "../schemas/errors.ts";
import { ownRoot } from "./launch.ts";

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

/** Where `specifier`, imported by a file in `dir`, resolves as if that file sat in `root`. */
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Bare specifiers as if imported from `root`, falling back to the running monkeyshape. */
const resolveBare = (specifier: string, root: string): string | undefined => {
  for (const from of [root, ownRoot()])
    try {
      return Bun.resolveSync(specifier, from);
    } catch {
      // Not there: the running monkeyshape next, then Bun's own resolution.
    }
  return undefined;
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A config outside the repo (`--config`, for trying monkeyshape before adopting), as copies
 * in `dir` of it and every module it reaches by relative import outside the repo, with their
 * imports made absolute: bare ones resolved from the repo, relative ones to the copies (or,
 * inside the repo, to the files themselves). Imported where they are, Bun would resolve
 * `monkeyshape` from their directory upward and fall back to its global cache, where it may
 * be another version that can't see the repo's `effect`; runtime plugins never see those
 * imports. Returns each original's copy, the config's first.
 */
const outsideCopies = async (
  path: string,
  root: string,
  dir: string,
  copies: Map<string, string> = new Map(),
): Promise<Map<string, string>> => {
  const copy = join(dir, `${copies.size}-${basename(path)}`);
  copies.set(path, copy);
  const text = await Bun.file(path).text();
  let imports: ReturnType<Bun.Transpiler["scanImports"]> = [];
  try {
    imports = new Bun.Transpiler({ loader: "tsx" }).scanImports(text);
  } catch {
    // It doesn't parse: copied as it is, so importing it reports why; the error is renamed.
  }
  let rewritten = text;
  for (const specifier of new Set(imports.map((found) => found.path))) {
    if (specifier.includes(":")) continue;
    let target: string | undefined;
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      let file: string;
      try {
        file = Bun.resolveSync(specifier, dirname(path));
      } catch {
        file = resolve(dirname(path), specifier);
      }
      const outside = relative(root, file).startsWith("..");
      if (outside && SOURCE.test(file))
        target = copies.get(file) ?? (await outsideCopies(file, root, dir, copies)).get(file);
      else target = file;
    } else target = resolveBare(specifier, root);
    if (target === undefined) continue;
    // Only where it is imported: `from "x"`, `import "x"`, `import("x")`. The same text
    // elsewhere is data, such as a vendored record's `package: "monkeyshape"`.
    rewritten = rewritten.replace(
      new RegExp(`(\\bfrom\\s*|\\bimport\\s*\\(?\\s*)(["'])${escapeRegExp(specifier)}\\2`, "g"),
      (_, keyword: string) => `${keyword}${JSON.stringify(target)}`,
    );
  }
  await Bun.write(copy, rewritten);
  return copies;
};

/**
 * The repo's files the config reaches by relative import, directly or through other files it
 * imports, wherever the config is: its local rules and their helpers, repo-relative.
 */
const reachedFrom = async (config: string, root: string): Promise<ReadonlyArray<string>> => {
  const seen = new Set<string>([config]);
  const queue = [config];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    let imports: ReturnType<Bun.Transpiler["scanImports"]> = [];
    try {
      imports = new Bun.Transpiler({ loader: "tsx" }).scanImports(await Bun.file(file).text());
    } catch {
      // Unreadable or unparseable: loading the config reports it, if it matters.
    }
    for (const { path } of imports) {
      if (!path.startsWith(".")) continue;
      let target: string;
      try {
        target = Bun.resolveSync(path, dirname(file));
      } catch {
        continue;
      }
      if (seen.has(target) || !SOURCE.test(target)) continue;
      seen.add(target);
      queue.push(target);
    }
  }
  seen.delete(config);
  return [...seen]
    .map((file) => relative(root, file))
    .filter((file) => !file.startsWith(".."))
    .sort();
};

/** The repo's own config: `shape.toml`, or `shape.config.ts` until it is migrated. */
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
    if (ts) return join(root, TS_CONFIG_FILE);
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
    const problems = [...configProblems(config), ...unshipped(config), ...undeclared(config)];
    if (problems.length > 0)
      return yield* Effect.fail(new ConfigError({ path: shown, reason: problems.join("; ") }));
    return resolveConfig(config, shown, [], PACK_SOURCES);
  });

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
    const outside = relative(root, path).startsWith("..");
    if (!(yield* exists(path)))
      return yield* Effect.fail(
        new ConfigError({
          path: shown,
          reason: own ? "not found; every adopting repo has one" : "not found",
        }),
      );
    if (path.endsWith(".toml")) return yield* loadToml(root, path, shown);
    const module = yield* Effect.tryPromise({
      try: async () => {
        if (!outside) return (await import(path)) as { readonly default?: unknown };
        const dir = await mkdtemp(join(tmpdir(), "mshape-config-"));
        try {
          const copies = await outsideCopies(path, root, dir);
          try {
            return (await import(copies.get(path) ?? path)) as { readonly default?: unknown };
          } catch (cause) {
            // Errors in a copy name the file the user wrote.
            let message = loadFailure(cause);
            for (const [original, copy] of copies) message = message.replaceAll(copy, original);
            throw new Error(message);
          }
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      },
      catch: (cause) =>
        new ConfigError({
          path: shown,
          reason: `could not load: ${cause instanceof Error && !("position" in cause) ? cause.message : loadFailure(cause)}`,
        }),
    });
    const config = yield* decodeStrict(ShapeConfig)(module.default).pipe(
      Effect.mapError((error) => new ConfigError({ path: shown, reason: error.message })),
    );
    const problems = [...configProblems(config), ...unshipped(config), ...undeclared(config)];
    if (problems.length > 0)
      return yield* Effect.fail(new ConfigError({ path: shown, reason: problems.join("; ") }));
    const reached = yield* Effect.promise(() => reachedFrom(path, root));
    return resolveConfig(config, shown, reached, PACK_SOURCES);
  });
