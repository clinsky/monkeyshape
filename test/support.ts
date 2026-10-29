/** In-memory repos for tests: checks are pure, so no temp directories are needed. */
import type { Integration, Snapshot } from "../src/core/model.ts";
import { lineAt } from "../src/core/model.ts";
import { parse } from "../src/core/parse.ts";
import { type Rule, runRule } from "../src/core/rules/engine.ts";
import { type ResolvedConfig, resolveConfig, type ShapeConfig } from "../src/schemas/config.ts";

/**
 * Beads is ok when memories or bead ids are given, else absent; `beads` overrides that.
 * tsc and biome are unavailable unless their file lists are given, so coverage reads configs.
 */
export const repo = (
  files: Readonly<Record<string, string>>,
  options: {
    readonly scripts?: ReadonlyArray<string>;
    readonly memories?: Readonly<Record<string, string>>;
    readonly beadIds?: ReadonlyArray<string>;
    readonly beads?: Integration;
    readonly typechecked?: ReadonlyArray<string>;
    readonly linted?: ReadonlyArray<string>;
  } = {},
): Snapshot => {
  const beadsOk = options.memories !== undefined || options.beadIds !== undefined;
  const tool = (list: ReadonlyArray<string> | undefined): Integration =>
    list === undefined
      ? { state: "unavailable", reason: "not run in unit tests" }
      : { state: "ok" };
  return {
    files: Object.keys(files),
    texts: new Map(Object.entries(files)),
    packageScripts: new Set(options.scripts ?? []),
    memories: beadsOk ? new Map(Object.entries(options.memories ?? {})) : undefined,
    beadIds: beadsOk ? new Set(options.beadIds ?? []) : undefined,
    typechecked: options.typechecked === undefined ? undefined : new Set(options.typechecked),
    linted: options.linted === undefined ? undefined : new Set(options.linted),
    integrations: {
      beads: options.beads ?? (beadsOk ? { state: "ok" } : { state: "absent" }),
      tsc: tool(options.typechecked),
      biome: tool(options.linted),
    },
  };
};

export const config = (input: ShapeConfig = {}): ResolvedConfig => resolveConfig(input);

let counter = 0;

/** Lines a rule reports on `source`. */
export const ruleLines = (rule: Rule, source: string): ReadonlyArray<number> => {
  const parsed = parse(`fixture-${counter++}.ts`, source);
  return runRule(rule, parsed).map((finding) => lineAt(source, finding.offset));
};
