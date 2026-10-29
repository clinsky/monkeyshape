/** Loads `shape.config.ts` by importing it, then decodes it strictly. */
import { Effect } from "effect";
import { decodeStrict } from "../helpers/decodeStrict.ts";
import { resolveConfig, ShapeConfig } from "../schemas/config.ts";
import { ConfigError } from "../schemas/errors.ts";

export const CONFIG_FILE = "shape.config.ts";

/** `path` overrides the repo's own config, e.g. to try monkeyshape on a repo before adopting it. */
export const loadConfig = (root: string, path = `${root}/${CONFIG_FILE}`) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(path).exists())))
      return yield* Effect.fail(
        new ConfigError({ path: CONFIG_FILE, reason: "not found; every adopting repo has one" }),
      );
    const module = yield* Effect.tryPromise({
      try: () => import(path) as Promise<{ readonly default?: unknown }>,
      catch: (cause) =>
        new ConfigError({ path: CONFIG_FILE, reason: `could not load: ${String(cause)}` }),
    });
    const config = yield* decodeStrict(ShapeConfig)(module.default).pipe(
      Effect.mapError((error) => new ConfigError({ path: CONFIG_FILE, reason: error.message })),
    );
    return resolveConfig(config);
  });
