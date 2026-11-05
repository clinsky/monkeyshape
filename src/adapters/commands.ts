/** File modes and declared commands: what `coverage` judges of source it doesn't analyze. */
import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import { commandFiles } from "../core/coverage.ts";
import type { CommandRun, FileMode } from "../core/model.ts";
import type { DeclaredCommand, ResolvedConfig } from "../schemas/config.ts";
import { run, runTool } from "./process.ts";

const GIT_MODES: Readonly<Record<string, FileMode>> = {
  "100755": "executable",
  "120000": "symlink",
};

/**
 * Git's mode for each tracked file that isn't plain, and the disk's for untracked ones: git
 * records the executable bit, so a checkout without it (core.fileMode off) still says.
 */
export const loadModes = (root: string, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const staged = yield* run(root, ["git", "ls-files", "--stage", "-z"]);
    const tracked = new Set<string>();
    const modes = new Map<string, FileMode>();
    for (const entry of staged.code === 0 ? staged.stdout.split("\0") : []) {
      // `<mode> <object> <stage>\t<path>`
      const tab = entry.indexOf("\t");
      if (tab === -1) continue;
      const path = entry.slice(tab + 1);
      tracked.add(path);
      const mode = GIT_MODES[entry.slice(0, entry.indexOf(" "))];
      if (mode !== undefined) modes.set(path, mode);
    }
    for (const file of files) {
      if (tracked.has(file)) continue;
      const info = yield* Effect.promise(() => lstat(`${root}/${file}`).catch(() => undefined));
      if (info?.isSymbolicLink()) modes.set(file, "symlink");
      else if (info !== undefined && (info.mode & 0o111) !== 0) modes.set(file, "executable");
    }
    return modes as ReadonlyMap<string, FileMode>;
  });

const exists = (path: string) =>
  Effect.promise(() =>
    lstat(path).then(
      () => true,
      () => false,
    ),
  );

/** The program `env` would run: its first argument that is neither a flag nor `NAME=value`. */
const envTarget = (args: ReadonlyArray<string>): string | undefined =>
  args.find((arg) => !arg.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg));

/**
 * A script's interpreter, from its shebang: `#!/usr/bin/env [-S] <name> ...` gives the name
 * to find on PATH, `#!/abs/path ...` the path. Undefined for a file with no shebang.
 */
const interpreterOf = async (
  path: string,
): Promise<{ readonly name: string } | { readonly path: string } | undefined> => {
  const head = await Bun.file(path)
    .slice(0, 256)
    .text()
    .catch(() => "");
  if (!head.startsWith("#!")) return undefined;
  const [first = "", ...args] = (head.slice(2).split("\n")[0] ?? "").trim().split(/\s+/);
  if (first === "") return undefined;
  if (first.endsWith("/env")) {
    const name = envTarget(args);
    return name === undefined ? undefined : { name };
  }
  return { path: first };
};

/** Why a repo script can't run here: its interpreter is missing. Undefined when it can. */
const missingInterpreter = (path: string, shown: string) =>
  Effect.gen(function* () {
    const interpreter = yield* Effect.promise(() => interpreterOf(path));
    if (interpreter === undefined) return undefined;
    if ("name" in interpreter)
      return Bun.which(interpreter.name) === null
        ? `\`${interpreter.name}\`, the interpreter of \`${shown}\`, is not on PATH`
        : undefined;
    return (yield* exists(interpreter.path))
      ? undefined
      : `\`${interpreter.path}\`, the interpreter of \`${shown}\`, does not exist`;
  });

/**
 * The argv to spawn, or why the program isn't here. A path is the repo's own; a package bin
 * runs through the current bun, since its shim may start with `#!/usr/bin/env node`.
 */
const resolveProgram = (root: string, argv: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [program = "", ...rest] = argv;
    if (program === "bun") return { argv: [process.execPath, ...rest] } as const;
    if (program.includes("/")) {
      const path = program.startsWith("/") ? program : `${root}/${program}`;
      if (!(yield* exists(path))) return { missing: `\`${program}\` does not exist` } as const;
      // A wrapper missing its toolchain is unavailable; checked before it runs, since what
      // \`env\` prints for a missing program reads like a missing file.
      const missing = yield* missingInterpreter(path, program);
      return missing === undefined ? ({ argv: [path, ...rest] } as const) : ({ missing } as const);
    }
    if (program === "env") {
      const target = envTarget(rest);
      if (target !== undefined && Bun.which(target) === null)
        return { missing: `\`${target}\` is not on PATH` } as const;
    }
    const bin = `${root}/node_modules/.bin/${program}`;
    if (yield* exists(bin)) return { argv: [process.execPath, bin, ...rest] } as const;
    return Bun.which(program) === null
      ? ({ missing: `\`${program}\` is not on PATH` } as const)
      : ({ argv: [program, ...rest] } as const);
  });

const COMMAND_NOT_FOUND = 127;

/**
 * What a shell or a wrapper prints when a program it runs is missing: sh's "not found",
 * bash's "command not found", a wrapper's own "not installed", or \`env\`'s "env: '<name>':
 * No such file or directory" (quoted however the locale quotes), which names a program. Exit 127 alone isn't enough:
 * bash also exits 127 for a missing file it was given, which is a failure, never a toolchain
 * gap, and must not turn green under `optional`.
 */
const TOOL_MISSING =
  /\b(not found|not installed)\b|^(\S*\/)?env: \S.*: No such file or directory/im;

const runCommand = (root: string, command: DeclaredCommand) =>
  Effect.gen(function* () {
    const program = yield* resolveProgram(root, command.run);
    if ("missing" in program)
      return { state: "unavailable", reason: program.missing } satisfies CommandRun;
    const ran = yield* runTool(root, program.argv);
    const output = [ran.stdout, ran.stderr].filter((text) => text.trim() !== "").join("\n");
    if (ran.code === -1)
      return {
        state: "unavailable",
        reason: `it could not start: ${ran.stderr}`,
      } satisfies CommandRun;
    if (ran.code === COMMAND_NOT_FOUND && TOOL_MISSING.test(output))
      return {
        state: "unavailable",
        reason: `it exited 127, and a program it runs was not found: ${output.trim().split("\n").at(-1)}`,
      } satisfies CommandRun;
    return { state: "ran", code: ran.code, output } satisfies CommandRun;
  });

/** Runs each declared command whose files match, in order, one at a time. */
export const runCommands = (root: string, config: ResolvedConfig, files: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const runs = new Map<number, CommandRun>();
    for (const [index, command] of config.coverage.commands.entries())
      if (commandFiles(command, files).length > 0)
        runs.set(index, yield* runCommand(root, command));
    return runs as ReadonlyMap<number, CommandRun>;
  });
