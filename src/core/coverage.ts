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
import { claimOf, toCover } from "./sources.ts";

/** Every rule this check reports, as `coverage/<kind>`; test/core/ruleCases.test.ts covers each. */
export const COVERAGE_RULES = [
  "config",
  "typecheck",
  "lint",
  "uncovered",
  /** A pack's compiler reaches no such file: Rust's, from no target's `mod` tree. */
  "compile",
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

export const checkCoverage = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  for (const loaded of snapshot.packs) {
    const files = toCover(config, snapshot, loaded);
    // Nothing of this pack's to cover: its tools' configs answer for nothing, so none is needed.
    if (files.length === 0) continue;
    const judges = loaded.pack.tools.flatMap((tool) => {
      const ran = loaded.load.tools.find((run) => run.tool === tool.name)?.files;
      const approximated = ran === undefined ? tool.approximate?.(config, snapshot) : undefined;
      for (const problem of approximated?.problems ?? [])
        violations.push(violation("config", problem.file, problem.message));
      const covers = ran !== undefined ? (file: string) => ran.has(file) : approximated?.covers;
      return covers === undefined ? [] : [{ tool, covers }];
    });
    // File by file, each tool in the pack's order: a file's findings sit together.
    for (const file of files)
      for (const { tool, covers } of judges)
        if (!covers(file))
          violations.push(
            violation(tool.rule as (typeof COVERAGE_RULES)[number], file, tool.uncovered(config)),
          );
  }
  return [...violations, ...withoutTools(config, snapshot)];
};

/** The command as a reader types it, for messages and the per-command line. */
export const commandLabel = (command: DeclaredCommand): string => command.run.join(" ");

/**
 * The label on a command's line under `coverage`: on one line, whole. The report shortens
 * every part's label the same way, keeping both ends, so a command's program and the file it
 * checks both show; cutting here first would lose the file. Its findings keep the command whole.
 */
export const shortLabel = (command: DeclaredCommand): string =>
  commandLabel(command).replace(/\s+/g, " ");

/** The files a declared command covers, in `snapshot.files` order. */
export const commandFiles = (command: DeclaredCommand, files: ReadonlyArray<string>) =>
  files.filter((file) => command.files.some((pattern) => matchesPathOrBelow(file, pattern)));

/** An argument of a declared command's `run` that stands for the files its `files` matched. */
export const FILES_ARGUMENT = "{files}";

/**
 * The argv a declared command runs: `run`, with each `{files}` argument replaced by the files
 * its `files` matched, in order, so the command checks exactly those and no glob is wider
 * than what runs. Without one, `run` as written.
 */
export const commandArgv = (
  command: DeclaredCommand,
  files: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  command.run.flatMap((arg) => (arg === FILES_ARGUMENT ? commandFiles(command, files) : [arg]));

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
        config.configFile,
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
              config.configFile,
              `declared command \`${label}\` could not run: ${ran.reason}. Install its toolchain here (and in CI), or set \`optional: true\` on it if this machine may lack it.`,
            ),
          ];
    if (ran.code === 0) return own;
    return [
      ...own,
      violation(
        "command-failed",
        config.configFile,
        `declared command \`${label}\` exited ${ran.code}. Fix what it reports:${ran.output.trim() === "" ? " it printed nothing." : `\n${tail(ran.output)}`}`,
      ),
    ];
  });

/**
 * Executable source outside `coverage.exempt` segments that no listed pack claims: what the
 * declared commands answer for. A listed pack's files are held to its own tools instead.
 */
export const executableSources = (config: ResolvedConfig, snapshot: Snapshot) => {
  const segments = new Set(config.coverage.exempt);
  return snapshot.files.filter(
    (file) =>
      classify(file, snapshot.modes.get(file)) === "executable" &&
      !file.split("/").some((segment) => segments.has(segment)) &&
      claimOf(snapshot, file) === undefined,
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
        `is ${snapshot.modes.get(file) === "executable" ? "an executable file" : "source"} that monkeyshape doesn't analyze, and no declared command checks it. Add a command that does to \`coverage.commands\` in ${config.configFile} (\`{ files, run }\`), or list it in \`coverage.exemptFiles\` with the reason it needs none.${snapshot.modes.get(file) === "executable" ? " If it is a compiled binary, no command checks it: exempt it with that reason, or stop tracking it and build it instead. A vendored release belongs in `files.vendored` with its package and sha256." : ""}`,
      ),
    );
  }
  for (const entry of config.coverage.exemptFiles)
    if (!snapshot.files.some((file) => matchesPathOrBelow(file, entry.path)))
      out.push(
        violation(
          "exempt-unmatched",
          config.configFile,
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
    toCover(config, snapshot).length === 0
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
