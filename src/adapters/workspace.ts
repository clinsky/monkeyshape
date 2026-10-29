/** Loads the repo into a `Snapshot`: git's file list, the texts checks read, scripts, memories. */
import { stat } from "node:fs/promises";
import { Effect } from "effect";
import { parseJsonc } from "../core/coverage.ts";
import { isTsSource, type Snapshot } from "../core/model.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import { WorkspaceError } from "../schemas/errors.ts";

const run = (root: string, command: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: async () => {
      const child = Bun.spawn([...command], { cwd: root, stdout: "pipe", stderr: "ignore" });
      const stdout = await new Response(child.stdout).text();
      return { stdout, code: await child.exited };
    },
    catch: (cause) =>
      new WorkspaceError({ operation: "run", path: command.join(" "), reason: String(cause) }),
  });

export const readText = (root: string, path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(`${root}/${path}`).text(),
    catch: (cause) => new WorkspaceError({ operation: "read", path, reason: String(cause) }),
  });

/** Files and directories alike: git lists a submodule as one entry, and it is a directory. */
const exists = (root: string, path: string) =>
  Effect.promise(() =>
    stat(`${root}/${path}`).then(
      () => true,
      () => false,
    ),
  );

const listFiles = (root: string) =>
  Effect.gen(function* () {
    const result = yield* run(root, [
      "git",
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    if (result.code !== 0)
      return yield* Effect.fail(
        new WorkspaceError({ operation: "list", path: root, reason: "not a git repository" }),
      );
    // Nested repositories and worktrees show up as a directory entry; they are not ours.
    return result.stdout.split("\0").filter((file) => file !== "" && !file.endsWith("/"));
  });

const memories = (root: string) =>
  Effect.gen(function* () {
    if (Bun.which("bd") === null || !(yield* exists(root, ".beads/config.yaml"))) return undefined;
    const result = yield* run(root, ["bd", "memories", "--json"]).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const parsed = result?.code === 0 ? parseJsonc(result.stdout) : undefined;
    if (typeof parsed !== "object" || parsed === null) return undefined;
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  });

const beadIds = (root: string) =>
  Effect.gen(function* () {
    if (Bun.which("bd") === null || !(yield* exists(root, ".beads/config.yaml"))) return undefined;
    const command = ["bd", "list", "--all", "--brief", "--skip-labels", "--limit", "0", "--json"];
    const result = yield* run(root, command).pipe(Effect.orElseSucceed(() => undefined));
    const parsed = result?.code === 0 ? parseJsonc(result.stdout) : undefined;
    // `bd list --limit 0 --json` wraps the rows as `{ issues: [...] }`; limited lists are bare.
    const rows =
      typeof parsed === "object" && parsed !== null && "issues" in parsed ? parsed.issues : parsed;
    if (!Array.isArray(rows)) return undefined;
    return new Set(
      rows.flatMap((issue: unknown) =>
        typeof issue === "object" && issue !== null && "id" in issue && typeof issue.id === "string"
          ? [issue.id]
          : [],
      ),
    );
  });

export const loadSnapshot = (root: string, config: ResolvedConfig) =>
  Effect.gen(function* () {
    const listed = yield* listFiles(root);
    // A file deleted but not yet staged is still listed; it isn't part of the repo now.
    const found = yield* Effect.forEach(listed, (file) => exists(root, file), { concurrency: 32 });
    const present = listed.filter((_, i) => found[i] === true);
    const configs = new Set([...config.coverage.tsconfigs, config.coverage.biome, "package.json"]);
    const wanted = present.filter(
      (file) => isTsSource(file) || file.endsWith(".md") || configs.has(file),
    );
    const texts = new Map(
      yield* Effect.forEach(
        wanted,
        (file) => Effect.map(readText(root, file), (text) => [file, text] as const),
        {
          concurrency: 32,
        },
      ),
    );
    const manifest = parseJsonc(texts.get("package.json") ?? "{}");
    const scripts =
      typeof manifest === "object" &&
      manifest !== null &&
      "scripts" in manifest &&
      typeof manifest.scripts === "object"
        ? Object.keys(manifest.scripts ?? {})
        : [];
    const snapshot: Snapshot = {
      files: present,
      texts,
      packageScripts: new Set(scripts),
      memories: yield* memories(root),
      beadIds: yield* beadIds(root),
    };
    return snapshot;
  });
