/** Loads `shape.config.ts` by importing it, then decodes it strictly. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { decodeStrict } from "../helpers/decodeStrict.ts";
import { resolveConfig, ShapeConfig } from "../schemas/config.ts";
import { ConfigError } from "../schemas/errors.ts";

export const CONFIG_FILE = "shape.config.ts";

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

/** The running monkeyshape's package directory, which resolves `monkeyshape` by its exports. */
const OWN_ROOT = `${import.meta.dir}/../..`;

/** Where `specifier`, imported by a file in `dir`, resolves as if that file sat in `root`. */
const resolveAt = (specifier: string, dir: string, root: string): string | undefined => {
  if (specifier.includes(":")) return undefined;
  if (specifier.startsWith(".") || specifier.startsWith("/")) return resolve(dir, specifier);
  for (const from of [root, OWN_ROOT])
    try {
      return Bun.resolveSync(specifier, from);
    } catch {
      // Not there: the running monkeyshape next, then Bun's own resolution.
    }
  return undefined;
};

/**
 * A config outside the repo (`--config`, for trying monkeyshape before adopting), as a copy
 * whose imports are absolute: bare ones resolved from the repo, relative ones from the
 * config's own directory. Imported where it is, Bun would resolve `monkeyshape` from the
 * config's directory upward and fall back to its global cache, where it may be another version
 * that can't see the repo's `effect`; its runtime plugins never see those imports.
 */
const outsideCopy = async (path: string, root: string): Promise<string> => {
  const text = await Bun.file(path).text();
  let imports: ReturnType<Bun.Transpiler["scanImports"]>;
  try {
    imports = new Bun.Transpiler({ loader: "ts" }).scanImports(text);
  } catch {
    // It doesn't parse: importing the file itself reports why, under its own name.
    return path;
  }
  let rewritten = text;
  for (const specifier of new Set(imports.map((found) => found.path))) {
    const target = resolveAt(specifier, dirname(path), root);
    if (target === undefined) continue;
    rewritten = rewritten.replace(
      new RegExp(`(["'])${specifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g"),
      JSON.stringify(target),
    );
  }
  const dir = await mkdtemp(join(tmpdir(), "mshape-config-"));
  const copy = join(dir, basename(path));
  await Bun.write(copy, rewritten);
  return copy;
};

/** `path` overrides the repo's own config, e.g. to try monkeyshape on a repo before adopting it. */
export const loadConfig = (root: string, path = `${root}/${CONFIG_FILE}`) =>
  Effect.gen(function* () {
    // The file tried, as the user would name it: `--config` may point anywhere.
    const shown = relative(root, path).startsWith("..") ? path : relative(root, path);
    const own = shown === CONFIG_FILE;
    const outside = relative(root, path).startsWith("..");
    if (!(yield* Effect.promise(() => Bun.file(path).exists())))
      return yield* Effect.fail(
        new ConfigError({
          path: shown,
          reason: own ? "not found; every adopting repo has one" : "not found",
        }),
      );
    const module = yield* Effect.tryPromise({
      try: async () => {
        if (!outside) return (await import(path)) as { readonly default?: unknown };
        const copy = await outsideCopy(path, root);
        try {
          return (await import(copy)) as { readonly default?: unknown };
        } catch (cause) {
          // Errors in the copy name the file the user gave.
          throw new Error(loadFailure(cause).replaceAll(copy, path));
        } finally {
          if (copy !== path) await rm(dirname(copy), { recursive: true, force: true });
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
    return resolveConfig(config);
  });
