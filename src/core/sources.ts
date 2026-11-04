/**
 * The rules' scope, accounted for. A rule that never saw a file can't fail on it, so a green
 * gate over a layout the defaults don't match (no `src/`) would mean nothing. Every
 * TypeScript file is in `sources`, or a test, or a declaration file, or exempt with a reason;
 * one that is none of them fails here. A glob the config wrote that matches no file fails
 * too, unless it is declared optional: a typo in a glob is otherwise a silent hole.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { matches, matchesAny } from "./glob.ts";
import { type Snapshot, TS_SOURCE, type Violation } from "./model.ts";

/** Every rule this check reports, as `sources/<kind>`; test/core/ruleCases.test.ts covers each. */
export const SOURCES_RULES = ["outside", "unmatched"] as const;

const violation = (
  rule: (typeof SOURCES_RULES)[number],
  file: string,
  message: string,
): Violation => ({ check: "sources", rule: `sources/${rule}`, file, message });

/** The config file `mshape` loads: data for monkeyshape, never part of the program. */
const CONFIG_FILE = "shape.config.ts";

const TEST_SEGMENTS = new Set(["test", "tests", "__tests__"]);

export const isDeclaration = (file: string): boolean => /\.d\.[cm]?ts$/.test(file);

/** `*.test.ts`, `*.spec.tsx`, or anything under a `test/`, `tests/` or `__tests__/` directory. */
export const isTest = (file: string): boolean =>
  /\.(test|spec)\.[cm]?tsx?$/.test(file) ||
  file
    .split("/")
    .slice(0, -1)
    .some((segment) => TEST_SEGMENTS.has(segment));

export type Place =
  | { readonly kind: "source" }
  | { readonly kind: "test" }
  | { readonly kind: "declaration" }
  | { readonly kind: "exempt"; readonly reason: string }
  | { readonly kind: "outside" };

export const inSources = (config: ResolvedConfig, file: string): boolean =>
  matchesAny(file, config.sources.include) && !matchesAny(file, config.sources.exclude);

/** Where one TypeScript file stands with the rules. */
export const placeOf = (config: ResolvedConfig, file: string): Place => {
  if (isDeclaration(file)) return { kind: "declaration" };
  if (file === CONFIG_FILE) return { kind: "exempt", reason: "monkeyshape's own config" };
  if (inSources(config, file)) return { kind: "source" };
  if (isTest(file)) return { kind: "test" };
  const exempt = config.sources.exempt.find((allowance) => matches(file, allowance.path));
  if (exempt !== undefined) return { kind: "exempt", reason: exempt.reason };
  const segments = new Set(config.coverage.exempt);
  if (file.split("/").some((segment) => segments.has(segment)))
    return { kind: "exempt", reason: "generated or vendored (coverage.exempt)" };
  return { kind: "outside" };
};

/** Every TypeScript file in the snapshot, by where it stands. */
export const places = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<{ readonly file: string; readonly place: Place }> =>
  snapshot.files
    .filter((file) => TS_SOURCE.test(file))
    .map((file) => ({ file, place: placeOf(config, file) }));

/** The glob a fix would add for `file`: its top-level directory, or the root, by its extension. */
const suggestedGlob = (file: string): string => {
  const extension = file.slice(file.lastIndexOf(".") + 1);
  const slash = file.indexOf("/");
  return slash === -1 ? `*.${extension}` : `${file.slice(0, slash)}/**/*.${extension}`;
};

/** How to fix one file outside the rules' scope, which depends on why it is outside. */
const outsideMessage = (config: ResolvedConfig, file: string): string =>
  matchesAny(file, config.sources.include)
    ? "is TypeScript in `sources.include` but removed by `sources.exclude`, so no rule analyzes it. `exclude` is for tests; move the glob to `sources.exempt` in shape.config.ts with the reason this code needn't be analyzed, or drop it from `exclude`."
    : `is TypeScript outside \`sources\`, so no rule analyzes it. Add a glob such as '${suggestedGlob(file)}' to \`sources.include\` in shape.config.ts, or list it in \`sources.exempt\` with the reason it needn't be.`;

export const checkSources = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  for (const declared of config.declared)
    if (!declared.optional && !snapshot.files.some((file) => matches(file, declared.glob)))
      violations.push(
        violation(
          "unmatched",
          CONFIG_FILE,
          `\`${declared.section}\` lists '${declared.glob}', which matches no file. Fix the glob, remove it, or write it as \`{ path: "${declared.glob}", optional: true }\` if the files are still to come.`,
        ),
      );
  for (const { file, place } of places(config, snapshot))
    if (place.kind === "outside")
      violations.push(violation("outside", file, outsideMessage(config, file)));
  return violations;
};
