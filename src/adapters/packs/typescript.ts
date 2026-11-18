/** The TypeScript pack's loader: tsc's and biome's own file lists, from the repo's install. */
import { realpath, stat } from "node:fs/promises";
import { posix } from "node:path";
import * as Effect from "effect/Effect";
import { parseJsonc } from "../../core/coverage.ts";
import { mainCheckout } from "../../core/layout.ts";
import type { Integration, PackLoader, ToolRun } from "../../packs/pack.ts";
import { exists, readText } from "../disk.ts";
import { BUN_FIX, BUN_NOT_FOUND, bunPath, runTool } from "../process.ts";

type Loaded<A> = { readonly integration: Integration; readonly value: A | undefined };

const failed = <A>(reason: string): Loaded<A> => ({
  integration: { state: "failed", reason },
  value: undefined,
});

const unavailable = (reason: string, fix?: string): Integration =>
  fix === undefined ? { state: "unavailable", reason } : { state: "unavailable", reason, fix };

/** The main checkout of `root`'s repository, which a track worktree shares; undefined if git can't say. */
const mainOf = (root: string) =>
  Effect.map(
    runTool(root, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"]),
    (got) => (got.code === 0 ? mainCheckout(got.stdout.trim()) : undefined),
  );

/**
 * A tool installed in the repo, as a command: the worktree's own install, else the main
 * checkout's, so a track worktree nobody ran `bun install` in still has tsc and biome. Run
 * through Bun (`bunPath`): the bin shims start with `#!/usr/bin/env node`, and a Bun-only
 * machine has no node. Else why it can't run: `pkg` isn't installed, or there is no Bun.
 */
export const localBin = (root: string, name: string, pkg: string) =>
  Effect.gen(function* () {
    const main = yield* mainOf(root);
    for (const dir of main === undefined || main === root ? [root] : [root, main])
      if (yield* exists(dir, `node_modules/.bin/${name}`)) {
        const bun = bunPath();
        return bun === undefined
          ? unavailable(BUN_NOT_FOUND, BUN_FIX)
          : [bun, `${dir}/node_modules/.bin/${name}`];
      }
    return unavailable(`${pkg} is not installed`);
  });

/**
 * The tsconfigs a project's references point at. A reference names a tsconfig file or a
 * directory holding `tsconfig.json`; references are not inherited through `extends`, so the
 * file's own JSON is the whole answer. Unreadable files yield none; tsc reports them itself.
 */
const referencesOf = (root: string, tsconfig: string) =>
  Effect.gen(function* () {
    const text = yield* readText(root, tsconfig).pipe(Effect.orElseSucceed(() => "{}"));
    const parsed = parseJsonc(text);
    const references =
      typeof parsed === "object" && parsed !== null && "references" in parsed
        ? parsed.references
        : undefined;
    if (!Array.isArray(references)) return [];
    const out: Array<string> = [];
    for (const reference of references) {
      if (typeof reference !== "object" || reference === null || !("path" in reference)) continue;
      if (typeof reference.path !== "string") continue;
      const target = posix.normalize(posix.join(posix.dirname(tsconfig), reference.path));
      const isDirectory = yield* Effect.promise(() =>
        stat(`${root}/${target}`).then(
          (info) => info.isDirectory(),
          () => false,
        ),
      );
      out.push(isDirectory ? posix.join(target, "tsconfig.json") : target);
    }
    return out;
  });

/**
 * The union of every configured tsconfig's program and, transitively, of every project it
 * references, as tsc itself resolves each one. `tsc -p` checks one project and `--build`
 * won't list files, so the reference graph is walked here, each project once.
 */
const typechecked = (root: string, realRoot: string, tsconfigs: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const tsc = yield* localBin(root, "tsc", "typescript");
    if (!Array.isArray(tsc))
      return {
        integration: tsc,
        value: undefined,
      } satisfies Loaded<ReadonlySet<string>>;
    const files = new Set<string>();
    const seen = new Set<string>();
    const queue = tsconfigs.map((tsconfig) => posix.normalize(tsconfig));
    for (let tsconfig = queue.shift(); tsconfig !== undefined; tsconfig = queue.shift()) {
      if (seen.has(tsconfig)) continue;
      seen.add(tsconfig);
      const result = yield* runTool(root, [...tsc, "-p", tsconfig, "--listFilesOnly"]);
      if (result.code !== 0)
        return failed<ReadonlySet<string>>(
          `\`tsc -p ${tsconfig} --listFilesOnly\` exited ${result.code}`,
        );
      for (const line of result.stdout.split("\n"))
        if (line.startsWith(`${realRoot}/`)) files.add(line.slice(realRoot.length + 1));
      queue.push(...(yield* referencesOf(root, tsconfig)));
    }
    return { integration: { state: "ok" }, value: files } satisfies Loaded<ReadonlySet<string>>;
  });

/** The files biome processes, from its verbose report, with `extends` and ignores resolved. */
const linted = (root: string) =>
  Effect.gen(function* () {
    const biome = yield* localBin(root, "biome", "@biomejs/biome");
    if (!Array.isArray(biome))
      return {
        integration: biome,
        value: undefined,
      } satisfies Loaded<ReadonlySet<string>>;
    const result = yield* runTool(root, [
      ...biome,
      "lint",
      "--verbose",
      "--colors=off",
      "--max-diagnostics=0",
      ".",
    ]);
    const report = result.stdout.split("Files processed:")[1];
    if (report === undefined)
      return failed<ReadonlySet<string>>(
        `\`biome lint --verbose\` printed no "Files processed:" list (exit ${result.code})`,
      );
    const files = new Set(
      report.split("\n").flatMap((line) => {
        const match = /^\s+- (.+)$/.exec(line);
        return match?.[1] === undefined ? [] : [match[1].trim()];
      }),
    );
    return { integration: { state: "ok" }, value: files } satisfies Loaded<ReadonlySet<string>>;
  });

/** Not asked: coverage alone reads tsc's and biome's lists. */
const NOT_SELECTED: Integration = {
  state: "unavailable",
  reason: "not run: coverage is not among the selected checks",
};

const toolRun = (tool: string, loaded: Loaded<ReadonlySet<string>>): ToolRun => ({
  tool,
  integration: loaded.integration,
  files: loaded.value,
});

/** tsc and biome run only when coverage is selected: they can take minutes. */
export const loadTypescript: PackLoader = ({ root, config, checks }) =>
  Effect.gen(function* () {
    if (!checks.includes("coverage"))
      return {
        tools: ["tsc", "biome"].map((tool) => ({
          tool,
          integration: NOT_SELECTED,
          files: undefined,
        })),
        outputs: new Map(),
      };
    const realRoot = yield* Effect.promise(() => realpath(root));
    const tsc = yield* typechecked(root, realRoot, config.coverage.tsconfigs);
    const biome = yield* linted(root);
    return { tools: [toolRun("tsc", tsc), toolRun("biome", biome)], outputs: new Map() };
  });
