/** File modes and declared commands: what `coverage` judges of source it doesn't analyze. */
import { lstat } from "node:fs/promises";
import { Effect } from "effect";
import { commandFiles, commandLabel } from "../core/coverage.ts";
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
      return (yield* exists(path))
        ? ({ argv: [path, ...rest] } as const)
        : ({ missing: `\`${program}\` does not exist` } as const);
    }
    const bin = `${root}/node_modules/.bin/${program}`;
    if (yield* exists(bin)) return { argv: [process.execPath, bin, ...rest] } as const;
    return Bun.which(program) === null
      ? ({ missing: `\`${program}\` is not on PATH` } as const)
      : ({ argv: [program, ...rest] } as const);
  });

const COMMAND_NOT_FOUND = 127;

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
    if (ran.code === COMMAND_NOT_FOUND)
      return {
        state: "unavailable",
        reason: `\`${commandLabel(command)}\` exited 127, a command it runs was not found${output === "" ? "" : `: ${output.trim().split("\n").at(-1)}`}`,
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
