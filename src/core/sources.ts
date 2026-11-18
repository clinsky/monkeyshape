/**
 * The rules' scope, accounted for. A rule that never saw a file can't fail on it, so a green
 * gate over a layout the defaults don't match (no `src/`) would mean nothing. Every
 * TypeScript file is in `sources`, or a test, or a declaration file, or exempt with a reason;
 * one that is none of them fails here, as does a file two listed packs claim, one only an
 * unlisted pack claims, and a file in `sources` no listed pack reads. A glob the config wrote that matches no file fails
 * too, unless it is declared optional: a typo in a glob is otherwise a silent hole.
 */

import type { FileKind, LoadedPack } from "../packs/pack.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import { matches, matchesAny, matchesPathOrBelow } from "./glob.ts";
import type { Snapshot, Violation } from "./model.ts";

/** Every rule this check reports, as `sources/<kind>`; test/core/ruleCases.test.ts covers each. */
export const SOURCES_RULES = [
  "outside",
  "unmatched",
  "claimed-twice",
  "unlisted-pack",
  "unclaimed",
] as const;

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

/** The first listed pack that claims `file`, and what the file is to it. */
export const claimOf = (
  snapshot: Pick<Snapshot, "packs">,
  file: string,
): { readonly loaded: LoadedPack; readonly kind: FileKind } | undefined => {
  for (const loaded of snapshot.packs) {
    const kind = loaded.pack.kindOf(file);
    if (kind !== undefined) return { loaded, kind };
  }
  return undefined;
};

/** Where one claimed file stands with the rules, `kind` being what its pack says it is. */
export const placeOf = (config: ResolvedConfig, file: string, kind: FileKind): Place => {
  if (kind === "declaration") return { kind: "declaration" };
  if (file === CONFIG_FILE) return { kind: "exempt", reason: "monkeyshape's own config" };
  if (inSources(config, file)) return { kind: "source" };
  if (kind === "test") return { kind: "test" };
  const exempt = config.sources.exempt.find((allowance) => matches(file, allowance.path));
  if (exempt !== undefined) return { kind: "exempt", reason: exempt.reason };
  const segments = new Set(config.coverage.exempt);
  if (file.split("/").some((segment) => segments.has(segment)))
    return { kind: "exempt", reason: "generated or vendored (coverage.exempt)" };
  return { kind: "outside" };
};

/**
 * The files coverage holds to a pack's tools: every one it claims bar declarations, outside
 * `coverage.exempt` segments; with `pack`, only that pack's. Here, not in check.ts, so
 * coverage.ts can share it without an import cycle.
 */
export const toCover = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  pack?: LoadedPack,
): ReadonlyArray<string> => {
  const exempt = new Set(config.coverage.exempt);
  return snapshot.files.filter((file) => {
    const claim = claimOf(snapshot, file);
    return (
      claim !== undefined &&
      (pack === undefined || claim.loaded === pack) &&
      claim.kind !== "declaration" &&
      !file.split("/").some((segment) => exempt.has(segment))
    );
  });
};

/** Every file a listed pack claims, by where it stands. */
export const places = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<{ readonly file: string; readonly place: Place }> =>
  snapshot.files.flatMap((file) => {
    const claim = claimOf(snapshot, file);
    return claim === undefined ? [] : [{ file, place: placeOf(config, file, claim.kind) }];
  });

/**
 * Each file belongs to one pack. A file two listed packs claim fails; so does a file only an
 * unlisted pack claims, unless the repo checks it its own way: a declared command covers it,
 * or `coverage` exempts it (a few scripts in another language need no pack).
 */
const claims = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const segments = new Set(config.coverage.exempt);
  const ownWay = (file: string) =>
    file.split("/").some((segment) => segments.has(segment)) ||
    config.coverage.exemptFiles.some((entry) => matchesPathOrBelow(file, entry.path)) ||
    config.coverage.commands.some((command) =>
      command.files.some((pattern) => matchesPathOrBelow(file, pattern)),
    );
  return snapshot.files.flatMap((file) => {
    const listed = snapshot.packs.filter(({ pack }) => pack.kindOf(file) !== undefined);
    const [first, second] = listed;
    if (first !== undefined && second !== undefined)
      return [
        violation(
          "claimed-twice",
          file,
          `is claimed by two packs in \`packs\`, \`${first.pack.id}\` and \`${second.pack.id}\`, and a file belongs to one. List only one of them in ${config.configFile}, or move the file where one pack's files are.`,
        ),
      ];
    if (first !== undefined) return [];
    const other = snapshot.otherPacks.find((pack) => pack.kindOf(file) !== undefined);
    // In the rules' scope, but no listed pack can read it: the rules never see it.
    if (inSources(config, file) && (other === undefined || ownWay(file)))
      return [
        violation(
          "unclaimed",
          file,
          `is in \`sources\`, but no pack in \`packs\` (${snapshot.packs.map(({ pack }) => pack.id).join(", ")}) reads its language, so no rule analyzes it. Narrow \`sources.include\` in ${config.configFile} to the packs' own files (their default is ${snapshot.packs
            .flatMap(({ pack }) => pack.defaultSources.include)
            .map((glob) => `'${glob}'`)
            .join(", ")}), or list the pack its language needs in \`packs\`.`,
        ),
      ];
    return other === undefined || ownWay(file)
      ? []
      : [
          violation(
            "unlisted-pack",
            file,
            `is ${other.language}, but \`packs\` in ${config.configFile} doesn't list \`${other.id}\`, so no check reads it. Add \`"${other.id}"\` to \`packs\`; or, if the repo checks it its own way, cover it with a command in \`coverage.commands\` or list it in \`coverage.exemptFiles\` with the reason.`,
          ),
        ];
  });
};

/** The glob a fix would add for `file`: its top-level directory, or the root, by its extension. */
const suggestedGlob = (file: string): string => {
  const extension = file.slice(file.lastIndexOf(".") + 1);
  const slash = file.indexOf("/");
  return slash === -1 ? `*.${extension}` : `${file.slice(0, slash)}/**/*.${extension}`;
};

/** How to fix one file outside the rules' scope, which depends on why it is outside. */
const outsideMessage = (config: ResolvedConfig, file: string, language: string): string =>
  matchesAny(file, config.sources.include)
    ? `is ${language} in \`sources.include\` but removed by \`sources.exclude\`, so no rule analyzes it. \`exclude\` is for tests; move the glob to \`sources.exempt\` in ${config.configFile} with the reason this code needn't be analyzed, or drop it from \`exclude\`.`
    : `is ${language} outside \`sources\`, so no rule analyzes it. Add a glob such as '${suggestedGlob(file)}' to \`sources.include\` in ${config.configFile}, or list it in \`sources.exempt\` with the reason it needn't be.`;

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
          config.configFile,
          `\`${declared.section}\` lists '${declared.glob}', which matches no file. Fix the glob, remove it, or write it as \`{ path: "${declared.glob}", optional: true }\` if the files are still to come.`,
        ),
      );
  for (const { file, place } of places(config, snapshot))
    if (place.kind === "outside")
      violations.push(
        violation(
          "outside",
          file,
          outsideMessage(config, file, claimOf(snapshot, file)?.loaded.pack.language ?? "source"),
        ),
      );
  violations.push(...claims(config, snapshot));
  return violations;
};
