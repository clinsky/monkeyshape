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
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;

/** Bare specifiers as if imported from `root`, falling back to the running monkeyshape. */
const resolveBare = (specifier: string, root: string): string | undefined => {
  for (const from of [root, OWN_ROOT])
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
    return resolveConfig(config);
  });
