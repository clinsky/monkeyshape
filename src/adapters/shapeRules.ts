/**
 * Runs the repo's own rules, `shape-rules/<id>.yml`, through the ast-grep `mshape` pins: each
 * rule over the repo, and each of its cases (`<id>.test.yml`) on its own. A repo without
 * rule files never fetches ast-grep. What ran is plain data for the rules engine.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import type { ShapeCaseRun, ShapeRuleCases, ShapeRuleRun, ShapeRules } from "../core/model.ts";
import { casesFileOf, isShapeRuleFile, SHAPE_RULES_DIR } from "../core/rules/shapeRules.ts";
import { AST_GREP, type ToolPin } from "../core/tools.ts";
import { runTool } from "./process.ts";
import { toolFor } from "./tools.ts";

/** At most this many ast-grep processes at once. */
const CONCURRENCY = 8;

const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

/** YAML as a value, or why it isn't YAML. */
const parseYaml = (source: string): { value: unknown } | { reason: string } => {
  try {
    return { value: Bun.YAML.parse(source) };
  } catch (cause) {
    return { reason: String(cause instanceof Error ? cause.message : cause) };
  }
};

/** ast-grep's reason for refusing, in one line: its first line and its last cause. */
const reasonOf = (stderr: string, code: number): string => {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const first = lines[0]?.replace(/^Error:\s*/u, "") ?? `ast-grep exited ${code}`;
  const cause = lines.findLast((line) => line.startsWith("╰▻"))?.replace(/^╰▻\s*/u, "");
  return cause === undefined ? first : `${first}: ${cause}`;
};

interface Scanned {
  readonly matches: ShapeRuleRun["matches"];
  readonly error?: string;
}

/**
 * One `ast-grep scan` of `rule`, over the repo or over `stdin`. `--hint` sets every rule's
 * severity to hint, so a match never makes ast-grep exit nonzero (a rule of severity `error`
 * would): the engine and the config own what a match costs, and a nonzero exit is a refusal.
 */
const scan = (sg: string, root: string, rule: string, stdin?: string) =>
  Effect.map(
    runTool(
      root,
      [
        sg,
        "scan",
        "--color",
        "never",
        "--hint",
        "--rule",
        rule,
        "--json=stream",
        ...(stdin === undefined ? ["."] : ["--stdin"]),
      ],
      stdin,
    ),
    (ran): Scanned => {
      if (ran.code !== 0) return { matches: [], error: reasonOf(ran.stderr, ran.code) };
      const matches = ran.stdout
        .split("\n")
        .filter((line) => line.trim() !== "")
        .flatMap((line) => {
          try {
            const match = JSON.parse(line) as {
              file?: unknown;
              message?: unknown;
              range?: { start?: { line?: unknown } };
            };
            const at = match.range?.start?.line;
            const file = text(match.file);
            const message = text(match.message);
            // ast-grep's lines start at 0; the engine's at 1.
            return file === undefined || typeof at !== "number"
              ? []
              : [
                  {
                    file: file.replace(/^\.\//u, ""),
                    line: at + 1,
                    ...(message === undefined ? {} : { message }),
                  },
                ];
          } catch {
            return [];
          }
        });
      return { matches };
    },
  );

/** A case: source text, run on stdin, or source at a repo path, run as a scan of that file. */
interface Case {
  readonly kind: "valid" | "invalid";
  readonly index: number;
  readonly code: string;
  readonly path?: string;
}

/** A repo-relative path a case may name: no `..`, not absolute. */
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]+$/u;

/** Why `entry` isn't a case: a snippet, or `{ path, code }`. */
const caseOf = (
  entry: unknown,
): { readonly code: string; readonly path?: string } | { readonly reason: string } => {
  if (typeof entry === "string") return { code: entry };
  if (typeof entry !== "object" || entry === null || Array.isArray(entry))
    return { reason: "is neither a source snippet nor `{ path, code }`" };
  const { path, code, ...rest } = entry as { path?: unknown; code?: unknown };
  if (Object.keys(rest).length > 0)
    return {
      reason: `has ${Object.keys(rest)
        .map((key) => `\`${key}\``)
        .join(", ")}: a case is \`{ path, code }\``,
    };
  if (typeof code !== "string") return { reason: "has no `code`, the source to run the rule on" };
  if (typeof path !== "string" || !SAFE_PATH.test(path))
    return { reason: `has \`path: ${JSON.stringify(path)}\`, not a path inside the repo` };
  return { code, path };
};

/**
 * A case at a path: written to its path in a scratch directory and scanned there, so the
 * rule's own `files` and `ignores` decide whether it applies, as in a real run. On stdin
 * they can't: ast-grep has no path to match them against.
 */
const scanAt = (sg: string, rule: string, path: string, code: string) =>
  Effect.acquireUseRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-shape-case-"))),
    (dir) =>
      Effect.gen(function* () {
        yield* Effect.promise(async () => {
          await mkdir(dirname(join(dir, path)), { recursive: true });
          await Bun.write(join(dir, path), code);
        });
        return yield* scan(sg, dir, rule);
      }),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  );

/** A rule's cases file, read and each case run, or why it can't be. */
const runCases = (sg: string, root: string, rule: string, files: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const file = casesFileOf(rule);
    if (!files.has(file)) return { state: "absent" } satisfies ShapeRuleCases;
    const source = yield* Effect.promise(() => Bun.file(`${root}/${file}`).text());
    const parsed = parseYaml(source);
    if ("reason" in parsed) return { state: "invalid", file, reason: parsed.reason } as const;
    const value = parsed.value;
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return {
        state: "invalid",
        file,
        reason: "it is not a map of `valid` and `invalid`",
      } as const;
    const lists = value as { valid?: unknown; invalid?: unknown };
    const cases: Array<Case> = [];
    for (const kind of ["invalid", "valid"] as const) {
      const list = lists[kind];
      if (list === undefined || list === null) continue;
      if (!Array.isArray(list))
        return {
          state: "invalid",
          file,
          reason: `\`${kind}\` is not a list of cases (source snippets, or \`{ path, code }\`)`,
        } as const;
      for (const [i, entry] of list.entries()) {
        const found = caseOf(entry);
        if ("reason" in found)
          return {
            state: "invalid",
            file,
            reason: `its ${kind} case ${i + 1} ${found.reason}`,
          } as const;
        cases.push({ kind, index: i + 1, ...found });
      }
    }
    // The rule by its absolute path: a case at a path is scanned from a scratch directory.
    const rulePath = join(root, rule);
    const runs = yield* Effect.forEach(
      cases,
      ({ kind, index, code, path }) =>
        Effect.map(
          path === undefined ? scan(sg, root, rule, code) : scanAt(sg, rulePath, path, code),
          (scanned): ShapeCaseRun => ({
            kind,
            index,
            matches: scanned.matches.length,
            ...(scanned.error === undefined ? {} : { error: scanned.error }),
          }),
        ),
      { concurrency: CONCURRENCY },
    );
    return { state: "ran", file, runs } as const;
  });

/** One rule file: its fields, its matches over the repo, and its cases. */
const runRule = (sg: string, root: string, file: string, files: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const source = yield* Effect.promise(() => Bun.file(`${root}/${file}`).text());
    const parsed = parseYaml(source);
    const value =
      "value" in parsed && typeof parsed.value === "object" && parsed.value !== null
        ? (parsed.value as {
            id?: unknown;
            language?: unknown;
            message?: unknown;
            metadata?: unknown;
          })
        : undefined;
    const fields = {
      id: text(value?.id),
      language: text(value?.language),
      message: text(value?.message),
      bugClass: text((value?.metadata as { bugClass?: unknown } | undefined)?.bugClass),
    };
    // ast-grep reads `---`-separated rules from one file; monkeyshape pairs a file with one
    // rule, its id and its cases.
    const refused =
      "reason" in parsed
        ? `it is not YAML: ${parsed.reason}`
        : Array.isArray(parsed.value)
          ? `it holds ${parsed.value.length} rules: one rule per file, so each has its own id, file and cases. Split it into ${SHAPE_RULES_DIR}/<id>.yml files`
          : undefined;
    if (refused !== undefined)
      return {
        file,
        ...fields,
        error: refused,
        matches: [],
        cases: { state: "absent" },
      } satisfies ShapeRuleRun;
    const scanned = yield* scan(sg, root, file);
    // A rule ast-grep refuses can't run its cases either.
    const cases =
      scanned.error === undefined
        ? yield* runCases(sg, root, file, files)
        : ({ state: "absent" } as const);
    return {
      file,
      ...fields,
      ...(scanned.error === undefined ? {} : { error: scanned.error }),
      matches: scanned.matches,
      cases,
    } satisfies ShapeRuleRun;
  });

/**
 * The repo's shape-rules as ast-grep ran them; undefined when `files` has none, and then
 * ast-grep isn't fetched. `cache` is where tools are kept (`cacheRoot`).
 */
export const loadShapeRules = (
  root: string,
  files: ReadonlyArray<string>,
  cache: string,
  pin: ToolPin = AST_GREP,
) =>
  Effect.gen(function* () {
    const ruleFiles = files.filter(isShapeRuleFile).sort();
    if (ruleFiles.length === 0) return undefined;
    const tool = yield* toolFor(cache, pin, process.platform, process.arch);
    if (tool.state === "unavailable") return { integration: tool, rules: [] } satisfies ShapeRules;
    const listed = new Set(files);
    const rules = yield* Effect.forEach(
      ruleFiles,
      (file) => runRule(tool.path, root, file, listed),
      { concurrency: CONCURRENCY },
    );
    return { integration: { state: "ok" }, rules } satisfies ShapeRules;
  });

/**
 * For `mshape rules`: each rule file's id and bug class, as written, with nothing run. A file
 * that doesn't say is listed by its name, and `mshape check` says what is wrong with it.
 */
export const listShapeRules = (root: string) =>
  Effect.gen(function* () {
    const files = yield* Effect.promise(async () => {
      const found: Array<string> = [];
      for await (const file of new Bun.Glob(`${SHAPE_RULES_DIR}/*.{yml,yaml}`).scan(root))
        if (isShapeRuleFile(file)) found.push(file);
      return found.sort();
    });
    return yield* Effect.forEach(
      files,
      (file) =>
        Effect.promise(async () => {
          const parsed = parseYaml(await Bun.file(`${root}/${file}`).text());
          const value = "value" in parsed ? (parsed.value as Record<string, unknown> | null) : null;
          const name = (file.split("/").at(-1) ?? file).replace(/\.ya?ml$/u, "");
          return {
            id: `local/${text(value?.["id"]) ?? name}`,
            bugClass:
              text((value?.["metadata"] as Record<string, unknown> | undefined)?.["bugClass"]) ??
              `(no metadata.bugClass in ${file})`,
          };
        }),
      { concurrency: CONCURRENCY },
    );
  });
