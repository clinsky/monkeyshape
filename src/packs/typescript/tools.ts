/**
 * tsc and biome, the tools coverage holds every TypeScript file to. The loader asks each for
 * its own file list, with inheritance and project references resolved; reading their configs
 * here is the fallback when one couldn't run, and approximates both.
 */
import { parseJsonc } from "../../core/coverage.ts";
import { matchesPathOrBelow } from "../../core/glob.ts";
import { dirname } from "../../core/paths.ts";
import type { ResolvedConfig } from "../../schemas/config.ts";
import type { RepoView, Tool } from "../pack.ts";

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

const exemptHint = (config: ResolvedConfig): string =>
  `keep it under a directory named in \`coverage.exempt\` in shape.config.ts (by default ${config.coverage.exempt.join(", ")}). To hold it out on purpose for now, \`mshape baseline --init\` grandfathers it, and the ratchet keeps the count from growing.`;

const MISSING = "is missing or not valid JSON";

export const tsc: Tool = {
  name: "tsc",
  rule: "typecheck",
  uncovered: (config) =>
    `is not in the program of any tsconfig in \`coverage.tsconfigs\` (now ${config.coverage.tsconfigs.join(", ")}). Include it; if another tsconfig checks it, list that tsconfig in \`coverage.tsconfigs\`; or, if it is generated or vendored code, ${exemptHint(config)}`,
  approximate: (config: ResolvedConfig, repo: RepoView) => {
    const tsconfigs: Array<{ path: string; value: unknown }> = [];
    const problems: Array<{ file: string; message: string }> = [];
    for (const path of config.coverage.tsconfigs) {
      const text = repo.texts.get(path);
      const value = text === undefined ? undefined : parseJsonc(text);
      if (value === undefined) problems.push({ file: path, message: MISSING });
      else tsconfigs.push({ path, value });
    }
    return {
      problems,
      covers: (file) =>
        tsconfigs.length === 0 || tsconfigs.some((t) => tsconfigCovers(t.path, t.value, file)),
    };
  },
};

export const biome: Tool = {
  name: "biome",
  rule: "lint",
  uncovered: (config) =>
    `is not in biome's files.includes. Include it; or, if it is generated or vendored code, ${exemptHint(config)}`,
  approximate: (config: ResolvedConfig, repo: RepoView) => {
    const text = repo.texts.get(config.coverage.biome);
    const value = text === undefined ? undefined : parseJsonc(text);
    return {
      problems: value === undefined ? [{ file: config.coverage.biome, message: MISSING }] : [],
      covers: (file) => value === undefined || biomeCovers(value, file),
    };
  },
};
