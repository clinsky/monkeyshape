/** Reading the repo's files: a file's text, and whether a path exists. */
import { stat } from "node:fs/promises";
import * as Effect from "effect/Effect";
import { WorkspaceError } from "../schemas/errors.ts";

export const readText = (root: string, path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(`${root}/${path}`).text(),
    catch: (cause) => new WorkspaceError({ operation: "read", path, reason: String(cause) }),
  });

/** Files and directories alike: git lists a submodule as one entry, and it is a directory. */
export const exists = (root: string, path: string) =>
  Effect.promise(() =>
    stat(`${root}/${path}`).then(
      () => true,
      () => false,
    ),
  );

/** The text of each file at `paths` under `dir` that exists, by path: a package's shipped files. */
export const readPresent = (dir: string, paths: ReadonlyArray<string>) =>
  Effect.promise(async () => {
    const out = new Map<string, string>();
    for (const path of paths) {
      const file = Bun.file(`${dir}/${path}`);
      if (await file.exists()) out.set(path, await file.text());
    }
    return out;
  });
