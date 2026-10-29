/** In-memory repos for tests: checks are pure, so no temp directories are needed. */
import type { Snapshot } from "../src/core/model.ts";
import { lineAt } from "../src/core/model.ts";
import { parse } from "../src/core/parse.ts";
import { type Rule, runRule } from "../src/core/rules/engine.ts";
import { type ResolvedConfig, resolveConfig, type ShapeConfig } from "../src/schemas/config.ts";

export const repo = (
  files: Readonly<Record<string, string>>,
  options: {
    readonly scripts?: ReadonlyArray<string>;
    readonly memories?: Readonly<Record<string, string>>;
    readonly beadIds?: ReadonlyArray<string>;
  } = {},
): Snapshot => ({
  files: Object.keys(files),
  texts: new Map(Object.entries(files)),
  packageScripts: new Set(options.scripts ?? []),
  memories: options.memories === undefined ? undefined : new Map(Object.entries(options.memories)),
  beadIds: options.beadIds === undefined ? undefined : new Set(options.beadIds),
});

export const config = (input: ShapeConfig = {}): ResolvedConfig => resolveConfig(input);

let counter = 0;

/** Lines a rule reports on `source`. */
export const ruleLines = (rule: Rule, source: string): ReadonlyArray<number> => {
  const parsed = parse(`fixture-${counter++}.ts`, source);
  return runRule(rule, parsed).map((finding) => lineAt(source, finding.offset));
};
