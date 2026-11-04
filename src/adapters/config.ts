/** Loads `shape.config.ts` by importing it, then decodes it strictly. */
import { relative } from "node:path";
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

/** `path` overrides the repo's own config, e.g. to try monkeyshape on a repo before adopting it. */
export const loadConfig = (root: string, path = `${root}/${CONFIG_FILE}`) =>
  Effect.gen(function* () {
    // The file tried, as the user would name it: `--config` may point anywhere.
    const shown = relative(root, path).startsWith("..") ? path : relative(root, path);
    const own = shown === CONFIG_FILE;
    if (!(yield* Effect.promise(() => Bun.file(path).exists())))
      return yield* Effect.fail(
        new ConfigError({
          path: shown,
          reason: own ? "not found; every adopting repo has one" : "not found",
        }),
      );
    const module = yield* Effect.tryPromise({
      try: () => import(path) as Promise<{ readonly default?: unknown }>,
      catch: (cause) =>
        new ConfigError({ path: shown, reason: `could not load: ${loadFailure(cause)}` }),
    });
    const config = yield* decodeStrict(ShapeConfig)(module.default).pipe(
      Effect.mapError((error) => new ConfigError({ path: shown, reason: error.message })),
    );
    return resolveConfig(config);
  });
