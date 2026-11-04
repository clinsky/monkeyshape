/** Sizes and vendored artifacts, read from disk: what the `files` check judges. */
import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import type { VendoredRead } from "../core/model.ts";
import type { ResolvedConfig } from "../schemas/config.ts";

/** Each file's size, from `lstat`: a symlink's is the link's own, never its target's. */
export const loadSizes = (root: string, files: ReadonlyArray<string>) =>
  Effect.map(
    Effect.forEach(
      files,
      (file) =>
        Effect.promise(() =>
          lstat(`${root}/${file}`).then(
            (info) => [file, info.size] as const,
            () => [file, 0] as const,
          ),
        ),
      { concurrency: 32 },
    ),
    (entries): ReadonlyMap<string, number> => new Map(entries),
  );

const MANIFEST = "package/package.json";

/** The name in an npm tarball's manifest. Bun reads the archive by its contents, not its name. */
const packageName = async (bytes: Uint8Array): Promise<VendoredRead["package"]> => {
  // A throw or a rejection, whichever Bun gives for bytes that aren't an archive.
  const entries = await Promise.resolve()
    .then(() => new Bun.Archive(bytes).files())
    .catch((cause: unknown) => cause);
  if (!(entries instanceof Map)) return { unreadable: `it is not an archive (${String(entries)})` };
  const manifest = entries.get(MANIFEST) as Blob | undefined;
  if (manifest === undefined) return { unreadable: `it has no ${MANIFEST}` };
  const parsed: unknown = await manifest.json().catch(() => undefined);
  const name =
    typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : undefined;
  return typeof name === "string" ? { name } : { unreadable: `its ${MANIFEST} has no name` };
};

/** Each recorded artifact present in `files`: its sha256 and the package it holds. */
export const loadVendored = (root: string, config: ResolvedConfig, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const present = new Set(files);
    const out = new Map<string, VendoredRead>();
    for (const { path } of config.files.vendored) {
      if (!present.has(path)) continue;
      const bytes = yield* Effect.promise(() => Bun.file(`${root}/${path}`).bytes());
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      out.set(path, { sha256, package: yield* Effect.promise(() => packageName(bytes)) });
    }
    return out as ReadonlyMap<string, VendoredRead>;
  });
