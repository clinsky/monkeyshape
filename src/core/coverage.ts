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
import { matchesPathOrBelow } from "./glob.ts";
import { stripJsonc } from "./jsonc.ts";
import { classify, isTsSource, type Snapshot, type Violation } from "./model.ts";
import { dirname } from "./paths.ts";

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

  const exempt = new Set(config.coverage.exempt);
  for (const file of snapshot.files) {
    if (!isTsSource(file) || file.split("/").some((segment) => exempt.has(segment))) continue;
    if (!isTypechecked(file))
      violations.push(
        violation(
          "typecheck",
          file,
          "is not in any tsconfig program. Include it, or move it under an exempt directory if it is generated.",
        ),
      );
    if (!isLinted(file))
      violations.push(
        violation(
          "lint",
          file,
          "is not in biome's files.includes. Include it, or move it under an exempt directory if it is generated.",
        ),
      );
  }
  return [...violations, ...uncovered(config, snapshot), ...commandViolations(config, snapshot)];
};

const CONFIG_FILE = "shape.config.ts";

/** The command as a reader types it, for messages and the per-command line. */
export const commandLabel = (command: DeclaredCommand): string => command.run.join(" ");

/** The files a declared command covers, in `snapshot.files` order. */
export const commandFiles = (command: DeclaredCommand, files: ReadonlyArray<string>) =>
  files.filter((file) => command.files.some((pattern) => matchesPathOrBelow(file, pattern)));

/**
 * What one declared command came to, under the outcome contract: `not-applicable` when its
 * files match nothing and it is optional, `unavailable` when its program is missing.
 */
export type CommandOutcome = "passed" | "failed" | "unavailable" | "not-applicable";

export interface CommandReport {
  readonly label: string;
  readonly files: number;
  readonly outcome: CommandOutcome;
  /** Why it failed or was unavailable; the command's own output's tail for a failure. */
  readonly detail?: string;
  readonly optional: boolean;
}

const TAIL_LINES = 30;

const tail = (output: string): string => {
  const lines = output.trimEnd().split("\n");
  const kept = lines.slice(-TAIL_LINES).join("\n");
  return lines.length > TAIL_LINES ? `(last ${TAIL_LINES} lines)\n${kept}` : kept;
};

/** One report per declared command, in config order: what `mshape check` prints for each. */
export const commandReports = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<CommandReport> =>
  config.coverage.commands.map((command, index) => {
    const label = commandLabel(command);
    const optional = command.optional === true;
    const files = commandFiles(command, snapshot.files).length;
    const ran = snapshot.commands.get(index);
    if (files === 0 || ran === undefined)
      return { label, files, optional, outcome: optional ? "not-applicable" : "failed" };
    if (ran.state === "unavailable")
      return { label, files, optional, outcome: "unavailable", detail: ran.reason };
    return ran.code === 0
      ? { label, files, optional, outcome: "passed" }
      : {
          label,
          files,
          optional,
          outcome: "failed",
          detail: `exited ${ran.code}${ran.output.trim() === "" ? "" : `:\n${tail(ran.output)}`}`,
        };
  });

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

/** Executable source no declared command covers, unless exempt by segment or with a reason. */
const uncovered = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const segments = new Set(config.coverage.exempt);
  const exemptPaths = config.coverage.exemptFiles.map((entry) => entry.path);
  const exempted = (file: string) =>
    exemptPaths.some((pattern) => matchesPathOrBelow(file, pattern));
  const covered = (file: string) =>
    config.coverage.commands.some((command) =>
      command.files.some((pattern) => matchesPathOrBelow(file, pattern)),
    );
  const out: Array<Violation> = [];
  for (const file of snapshot.files) {
    if (classify(file, snapshot.modes.get(file)) !== "executable") continue;
    if (file.split("/").some((segment) => segments.has(segment))) continue;
    if (exempted(file) || covered(file)) continue;
    out.push(
      violation(
        "uncovered",
        file,
        `is ${snapshot.modes.get(file) === "executable" ? "an executable file" : "source"} that monkeyshape doesn't analyze, and no declared command checks it. Add a command that does to \`coverage.commands\` in ${CONFIG_FILE} (\`{ files, run }\`), or list it in \`coverage.exemptFiles\` with the reason it needs none.${snapshot.modes.get(file) === "executable" ? " If it is a compiled binary, no command checks it: exempt it with that reason, or stop tracking it and build it instead." : ""}`,
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
