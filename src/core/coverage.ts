/**
 * Code outside the gate rots silently. Every TypeScript file must be typechecked by some
 * tsconfig and linted by biome, unless it sits under an exempt segment (generated or
 * vendored code). Excluding real code needs a config change a reviewer will see.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { matchesPathOrBelow } from "./glob.ts";
import { stripJsonc } from "./jsonc.ts";
import { isTsSource, type Snapshot, type Violation } from "./model.ts";
import { dirname } from "./paths.ts";

const violation = (rule: string, file: string, message: string): Violation => ({
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
  const files = strings(field(tsconfig, "files")) ?? [];
  if (files.some((entry) => entry.replace(/^\.\//, "") === relative)) return true;
  const include = strings(field(tsconfig, "include")) ?? (files.length === 0 ? ["**/*"] : []);
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
  for (const path of config.coverage.tsconfigs) {
    const text = snapshot.texts.get(path);
    const value = text === undefined ? undefined : parseJsonc(text);
    if (value === undefined)
      violations.push(violation("config", path, "is missing or not valid JSON"));
    else tsconfigs.push({ path, value });
  }
  const biomeText = snapshot.texts.get(config.coverage.biome);
  const biome = biomeText === undefined ? undefined : parseJsonc(biomeText);
  if (biome === undefined)
    violations.push(violation("config", config.coverage.biome, "is missing or not valid JSON"));

  const exempt = new Set(config.coverage.exempt);
  for (const file of snapshot.files) {
    if (!isTsSource(file) || file.split("/").some((segment) => exempt.has(segment))) continue;
    if (tsconfigs.length > 0 && !tsconfigs.some((t) => tsconfigCovers(t.path, t.value, file)))
      violations.push(
        violation(
          "typecheck",
          file,
          "is not in any tsconfig program. Include it, or move it under an exempt directory if it is generated.",
        ),
      );
    if (biome !== undefined && !biomeCovers(biome, file))
      violations.push(
        violation(
          "lint",
          file,
          "is not in biome's files.includes. Include it, or move it under an exempt directory if it is generated.",
        ),
      );
  }
  return violations;
};
