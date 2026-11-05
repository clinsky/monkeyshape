/**
 * Code outside the gate rots silently. Every TypeScript file must be typechecked by some
 * tsconfig and linted by biome, unless it sits under an exempt segment (generated or
 * vendored code). Excluding real code needs a config change a reviewer will see.
 *
 * Source in any other language is the adopter's to check: each executable file (see
 * `classify`) is covered by a declared command, which `mshape check` runs and judges here,
 * or exempt with a reason. monkeyshape never analyzes it.
 *
 * The tools are the authority: when the adapter could run them, `snapshot.typechecked` and
 * `snapshot.linted` are their own file lists, with inheritance and project references
 * resolved. Reading the configs here is the fallback, and approximates both.
 */
import type { DeclaredCommand, ResolvedConfig } from "../schemas/config.ts";
import { dataFormat, parseError } from "./data.ts";
import { matchesPathOrBelow } from "./glob.ts";
import { stripJsonc } from "./jsonc.ts";
import { classify, type Outcome, type Snapshot, type Violation } from "./model.ts";
import { dirname } from "./paths.ts";
import { tsToCover } from "./sources.ts";

/** Every rule this check reports, as `coverage/<kind>`; test/core/ruleCases.test.ts covers each. */
export const COVERAGE_RULES = [
  "config",
  "typecheck",
  "lint",
  "uncovered",
  "command-failed",
  "command-unavailable",
  "command-unmatched",
  "exempt-unmatched",
  "data",
] as const;

const violation = (
  rule: (typeof COVERAGE_RULES)[number],
  file: string,
  message: string,
): Violation => ({
  check: "coverage",
  rule: `coverage/${rule}`,
  file,
  message,
});

export const parseJsonc = (text: string): unknown => {
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;

const strings = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;

/** Whether one tsconfig's program includes `file` (repo-relative). */
export const tsconfigCovers = (tsconfigPath: string, tsconfig: unknown, file: string): boolean => {
  const base = dirname(tsconfigPath);
  const relative =
    base === "" ? file : file.startsWith(`${base}/`) ? file.slice(base.length + 1) : undefined;
  if (relative === undefined) return false;
  const files = strings(field(tsconfig, "files"));
  if (files?.some((entry) => entry.replace(/^\.\//, "") === relative)) return true;
  // Absent `include` defaults to everything only when `files` is absent too; `files: []`
  // (a solution-style config) includes nothing.
  const include = strings(field(tsconfig, "include")) ?? (files === undefined ? ["**/*"] : []);
  const exclude = strings(field(tsconfig, "exclude")) ?? [];
  return (
    include.some((pattern) => matchesPathOrBelow(relative, pattern)) &&
    !exclude.some((pattern) => matchesPathOrBelow(relative, pattern))
  );
};

/** Biome `files.includes`, in order: a later pattern overrides an earlier one. */
export const biomeCovers = (biome: unknown, file: string): boolean => {
  const includes = strings(field(field(biome, "files"), "includes"));
  if (includes === undefined) return true;
  let included = false;
  for (const pattern of includes) {
    const negated = pattern.startsWith("!");
    if (matchesPathOrBelow(file, pattern.replace(/^!+/, ""))) included = !negated;
  }
  return included;
};

export const checkCoverage = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const tsconfigs: Array<{ path: string; value: unknown }> = [];
  const typescript = tsToCover(config, snapshot);
  const others = withoutTools(config, snapshot);
  // No TypeScript to cover: tsc's and biome's configs answer for nothing, so none is needed.
  if (typescript.length === 0) return others;
  const typechecked = snapshot.typechecked;
  const linted = snapshot.linted;
  for (const path of typechecked === undefined ? config.coverage.tsconfigs : []) {
    const text = snapshot.texts.get(path);
    const value = text === undefined ? undefined : parseJsonc(text);
    if (value === undefined)
      violations.push(violation("config", path, "is missing or not valid JSON"));
    else tsconfigs.push({ path, value });
  }
  const biomeText = snapshot.texts.get(config.coverage.biome);
  const biome = biomeText === undefined ? undefined : parseJsonc(biomeText);
  if (linted === undefined && biome === undefined)
    violations.push(violation("config", config.coverage.biome, "is missing or not valid JSON"));
  const isTypechecked = (file: string) =>
    typechecked !== undefined
      ? typechecked.has(file)
      : tsconfigs.length === 0 || tsconfigs.some((t) => tsconfigCovers(t.path, t.value, file));
  const isLinted = (file: string) =>
    linted !== undefined ? linted.has(file) : biome === undefined || biomeCovers(biome, file);

  for (const file of typescript) {
    if (!isTypechecked(file))
      violations.push(
        violation(
          "typecheck",
          file,
          `is not in the program of any tsconfig in \`coverage.tsconfigs\` (now ${config.coverage.tsconfigs.join(", ")}). Include it; if another tsconfig checks it, list that tsconfig in \`coverage.tsconfigs\`; or, if it is generated or vendored code, keep it under a directory named in \`coverage.exempt\` in shape.config.ts (by default ${config.coverage.exempt.join(", ")}). To hold it out on purpose for now, \`mshape baseline --init\` grandfathers it, and the ratchet keeps the count from growing.`,
        ),
      );
    if (!isLinted(file))
      violations.push(
        violation(
          "lint",
          file,
          `is not in biome's files.includes. Include it; or, if it is generated or vendored code, keep it under a directory named in \`coverage.exempt\` in shape.config.ts (by default ${config.coverage.exempt.join(", ")}). To hold it out on purpose for now, \`mshape baseline --init\` grandfathers it, and the ratchet keeps the count from growing.`,
        ),
      );
  }
  return [...violations, ...others];
};

const CONFIG_FILE = "shape.config.ts";

/** The command as a reader types it, for messages and the per-command line. */
export const commandLabel = (command: DeclaredCommand): string => command.run.join(" ");

const SHORT_LABEL = 60;

/**
 * The label on a command's line under `coverage`: whole when short, else cut to one line.
 * Its findings' messages keep the whole command.
 */
export const shortLabel = (command: DeclaredCommand): string => {
  const whole = commandLabel(command).replace(/\s+/g, " ");
  return whole.length <= SHORT_LABEL ? whole : `${whole.slice(0, SHORT_LABEL - 1)}…`;
};

/** The files a declared command covers, in `snapshot.files` order. */
export const commandFiles = (command: DeclaredCommand, files: ReadonlyArray<string>) =>
  files.filter((file) => command.files.some((pattern) => matchesPathOrBelow(file, pattern)));

/** One declared command's line under `coverage`, in the outcome contract's terms. */
export interface CommandReport {
  readonly label: string;
  readonly outcome: Outcome;
}

const TAIL_LINES = 30;

const tail = (output: string): string => {
  const lines = output.trimEnd().split("\n");
  const kept = lines.slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_LINES ? `(last ${TAIL_LINES} lines)\n${kept}` : kept;
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * One report per declared command, in config order: `coverage`'s parts. `failed` when it
 * exited non-zero or a required command's files match nothing; the violation says why.
 */
export const commandReports = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<CommandReport> =>
  config.coverage.commands.map((command, index): CommandReport => {
    const label = shortLabel(command);
    const optional = command.optional === true;
    const examined = plural(commandFiles(command, snapshot.files).length, "file");
    const ran = snapshot.commands.get(index);
    if (ran === undefined)
      return {
        label,
        outcome: optional
          ? { state: "not-applicable", reason: "its files match nothing" }
          : { state: "failed", examined },
      };
    if (ran.state === "unavailable")
      return {
        label,
        outcome: {
          state: "unavailable",
          prerequisite: command.run[0] ?? label,
          reason: ran.reason,
          required: !optional,
        },
      };
    const unmatched =
      !optional &&
      command.files.some((pattern) => !snapshot.files.some((f) => matchesPathOrBelow(f, pattern)));
    return {
      label,
      outcome: { state: ran.code === 0 && !unmatched ? "passed" : "failed", examined },
    };
  });

/** What the declared commands found. */
const commandViolations = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> =>
  config.coverage.commands.flatMap((command, index): ReadonlyArray<Violation> => {
    const label = commandLabel(command);
    const optional = command.optional === true;
    const unmatched = command.files.filter(
      (pattern) => !snapshot.files.some((file) => matchesPathOrBelow(file, pattern)),
    );
    // `optional` is about absence only: it drops the unmatched globs, never the run's result.
    const own = (optional ? [] : unmatched).map((pattern) =>
      violation(
        "command-unmatched",
        CONFIG_FILE,
        `declared command \`${label}\` covers '${pattern}', which matches no file. Fix the glob, remove it, or set \`optional: true\` if its files may be absent.`,
      ),
    );
    const ran = snapshot.commands.get(index);
    if (ran === undefined) return own;
    if (ran.state === "unavailable")
      return optional
        ? own
        : [
            ...own,
            violation(
              "command-unavailable",
              CONFIG_FILE,
              `declared command \`${label}\` could not run: ${ran.reason}. Install its toolchain here (and in CI), or set \`optional: true\` on it if this machine may lack it.`,
            ),
          ];
    if (ran.code === 0) return own;
    return [
      ...own,
      violation(
        "command-failed",
        CONFIG_FILE,
        `declared command \`${label}\` exited ${ran.code}. Fix what it reports:${ran.output.trim() === "" ? " it printed nothing." : `\n${tail(ran.output)}`}`,
      ),
    ];
  });

/** Executable source outside `coverage.exempt` segments: what the declared commands answer for. */
export const executableSources = (config: ResolvedConfig, snapshot: Snapshot) => {
  const segments = new Set(config.coverage.exempt);
  return snapshot.files.filter(
    (file) =>
      classify(file, snapshot.modes.get(file)) === "executable" &&
      !file.split("/").some((segment) => segments.has(segment)),
  );
};

/** Executable source no declared command covers, unless exempt by segment or with a reason. */
const uncovered = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const exemptPaths = config.coverage.exemptFiles.map((entry) => entry.path);
  const exempted = (file: string) =>
    exemptPaths.some((pattern) => matchesPathOrBelow(file, pattern));
  const covered = (file: string) =>
    config.coverage.commands.some((command) =>
      command.files.some((pattern) => matchesPathOrBelow(file, pattern)),
    );
  const out: Array<Violation> = [];
  for (const file of executableSources(config, snapshot)) {
    if (exempted(file) || covered(file)) continue;
    out.push(
      violation(
        "uncovered",
        file,
        `is ${snapshot.modes.get(file) === "executable" ? "an executable file" : "source"} that monkeyshape doesn't analyze, and no declared command checks it. Add a command that does to \`coverage.commands\` in ${CONFIG_FILE} (\`{ files, run }\`), or list it in \`coverage.exemptFiles\` with the reason it needs none.${snapshot.modes.get(file) === "executable" ? " If it is a compiled binary, no command checks it: exempt it with that reason, or stop tracking it and build it instead. A vendored release belongs in `files.vendored` with its package and sha256." : ""}`,
      ),
    );
  }
  for (const entry of config.coverage.exemptFiles)
    if (!snapshot.files.some((file) => matchesPathOrBelow(file, entry.path)))
      out.push(
        violation(
          "exempt-unmatched",
          CONFIG_FILE,
          `\`coverage.exemptFiles\` lists '${entry.path}', which matches no file. Remove the entry, or fix its glob.`,
        ),
      );
  return out;
};

/**
 * What coverage finds without tsc or biome: uncovered source and the declared commands'
 * results. A report blocked by a missing tool still shows these.
 */
/** The structured data coverage parses: data by class, in a format it knows, not exempt. */
export const dataFiles = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<string> =>
  snapshot.files.filter(
    (file) =>
      classify(file, snapshot.modes.get(file)) === "data" &&
      dataFormat(file) !== undefined &&
      !config.coverage.exemptFiles.some((entry) => matchesPathOrBelow(file, entry.path)),
  );

/**
 * Structured data that doesn't parse, unless exempt (a deliberately broken fixture). The
 * tool configs are `coverage/config`'s whenever it reads them, which is whenever there is
 * TypeScript to cover: one finding per broken file.
 */
const unparsable = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const judged = new Set(
    tsToCover(config, snapshot).length === 0
      ? []
      : [...config.coverage.tsconfigs, config.coverage.biome],
  );
  return dataFiles(config, snapshot).flatMap((file) => {
    if (judged.has(file)) return [];
    const format = dataFormat(file);
    const text = snapshot.texts.get(file);
    if (format === undefined || text === undefined) return [];
    const error = parseError(format, text);
    return error === undefined
      ? []
      : [
          violation(
            "data",
            file,
            `does not parse as ${format.toUpperCase()}: ${error}. Fix it; if it is broken on purpose (a test fixture), list it in \`coverage.exemptFiles\` with that reason.${format === "json" ? " If its tool reads it with comments, name the file `.jsonc` where the tool accepts that name; where the tool needs this exact name, list it in `coverage.exemptFiles` with the reason (read as JSONC by that tool)." : ""}`,
          ),
        ];
  });
};

export const withoutTools = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => [
  ...uncovered(config, snapshot),
  ...unparsable(config, snapshot),
  ...commandViolations(config, snapshot),
];
