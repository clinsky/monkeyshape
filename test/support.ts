/** In-memory repos for tests: checks are pure, so no temp directories are needed. */
import type {
  BeadSummary,
  BeadsExport,
  CommandRun,
  FileMode,
  Integration,
  SkillsSnapshot,
  Snapshot,
  VendoredRead,
} from "../src/core/model.ts";
import { lineAt } from "../src/core/model.ts";
import { parse } from "../src/core/parse.ts";
import { type Rule, runRule } from "../src/core/rules/engine.ts";
import type { LoadedPack, Pack } from "../src/packs/pack.ts";
import { onText, typescript } from "../src/packs/typescript/index.ts";
import {
  type PackId,
  type ResolvedConfig,
  resolveConfig,
  type ShapeConfig,
} from "../src/schemas/config.ts";

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
    /** Beads for the beads check; their ids join `beadIds`. */
    readonly beadRows?: ReadonlyArray<BeadSummary>;
    readonly beads?: Integration;
    /** The export as the loader read it, where bd couldn't be. */
    readonly beadsExport?: BeadsExport;
    readonly typechecked?: ReadonlyArray<string>;
    readonly linted?: ReadonlyArray<string>;
    /** Overrides the state the lists above imply, e.g. a tool that ran and failed. */
    readonly tsc?: Integration;
    readonly biome?: Integration;
    /** The listed packs as loaded; the TypeScript pack with the tool runs above by default. */
    readonly packs?: ReadonlyArray<LoadedPack>;
    /** The shipped `copy` configs, by their path in the package. */
    readonly shippedConfigs?: Readonly<Record<string, string>>;
    /** Packs shipped but not listed; none by default. */
    readonly otherPacks?: ReadonlyArray<Pack>;
    readonly skills?: SkillsSnapshot;
    readonly shippedPrime?: string;
    /** The monkeyshape npm package's version in node_modules. */
    readonly installedMonkeyshape?: string;
    readonly unlisted?: ReadonlyArray<string>;
    /** Files that aren't plain, by path. */
    readonly modes?: Readonly<Record<string, FileMode>>;
    /** Declared commands' runs, by their index in `coverage.commands`. */
    readonly commands?: ReadonlyArray<CommandRun | undefined>;
    /** Sizes by path; a file not listed has its text's length. */
    readonly sizes?: Readonly<Record<string, number>>;
    /** Recorded vendored artifacts as read, by path. */
    readonly vendored?: Readonly<Record<string, VendoredRead>>;
  } = {},
): Snapshot => {
  const beadsOk =
    options.memories !== undefined ||
    options.beadIds !== undefined ||
    options.beadRows !== undefined;
  const tool = (list: ReadonlyArray<string> | undefined): Integration =>
    list === undefined
      ? { state: "unavailable", reason: "not run in unit tests" }
      : { state: "ok" };
  return {
    files: Object.keys(files),
    texts: new Map(Object.entries(files)),
    packageScripts: new Set(options.scripts ?? []),
    memories: beadsOk ? new Map(Object.entries(options.memories ?? {})) : undefined,
    beadIds: beadsOk
      ? new Set([...(options.beadIds ?? []), ...(options.beadRows ?? []).map((bead) => bead.id)])
      : undefined,
    beadRows: beadsOk ? (options.beadRows ?? []) : undefined,
    ...(options.beadsExport === undefined ? {} : { beadsExport: options.beadsExport }),
    otherPacks: options.otherPacks ?? [],
    shippedConfigs: new Map(Object.entries(options.shippedConfigs ?? {})),
    integrations: { beads: options.beads ?? (beadsOk ? { state: "ok" } : { state: "absent" }) },
    packs: options.packs ?? [
      {
        pack: typescript,
        load: {
          tools: [
            {
              tool: "tsc",
              integration: options.tsc ?? tool(options.typechecked),
              files: options.typechecked === undefined ? undefined : new Set(options.typechecked),
            },
            {
              tool: "biome",
              integration: options.biome ?? tool(options.linted),
              files: options.linted === undefined ? undefined : new Set(options.linted),
            },
          ],
          outputs: new Map(),
        },
      },
    ],
    skills: options.skills ?? {
      link: { kind: "missing" },
      installed: new Map(),
      claudeDirectory: new Map(),
      shipped: new Map(),
    },
    shippedPrime: options.shippedPrime,
    installedMonkeyshape: options.installedMonkeyshape,
    unlisted: new Set(options.unlisted ?? []),
    modes: new Map(Object.entries(options.modes ?? {})),
    sizes: new Map(
      Object.entries(files).map(([path, text]) => [path, options.sizes?.[path] ?? text.length]),
    ),
    vendored: new Map(Object.entries(options.vendored ?? {})),
    commands: new Map(
      (options.commands ?? []).flatMap((ran, index) =>
        ran === undefined ? [] : [[index, ran] as const],
      ),
    ),
  };
};

export const config = (input: ShapeConfig = {}): ResolvedConfig => resolveConfig(input);

let counter = 0;

/** Lines a rule reports on `source`. */
export const ruleLines = (rule: Rule, source: string): ReadonlyArray<number> => {
  const parsed = parse(`fixture-${counter++}.ts`, source);
  return runRule(rule, parsed).map((finding) => lineAt(source, finding.offset));
};

/** A tool's run, as the snapshot's packs hold it: `tsc`, `biome`. */
export const toolRun = (snapshot: Snapshot, tool: string) => {
  const run = snapshot.packs.flatMap(({ load }) => load.tools).find((one) => one.tool === tool);
  if (run === undefined) throw new Error(`no ${tool} run in the snapshot`);
  return run;
};

/**
 * A pack that claims files by extension and has no tools, rules or edges: enough for the core
 * to see a second language. `kindOf` says `test` under a `tests/` directory.
 */
export const fakePack = (id: PackId, language: string, extension: string): Pack => ({
  id,
  language,
  kindOf: (file) =>
    file.endsWith(`.${extension}`) ? (file.includes("tests/") ? "test" : "source") : undefined,
  comments: () => [],
  syntaxErrors: () => [],
  defaultSources: { include: [`**/*.${extension}`] },
  hostSpecifiers: [],
  graph: () => ({ edges: [], hostUses: [] }),
  tools: [],
  findings: () => [],
  findingKinds: [],
  rules: [],
  baseConfigs: [],
  template: `template/packs/${id}`,
  stages: [],
  prerequisites: [],
  loadFor: [],
});

/**
 * `snapshot` with `rules` as the TypeScript pack's rules in place of the registry's: a test of
 * one rule, or of the engine with none.
 */
export const ruled = (snapshot: Snapshot, rules: ReadonlyArray<Rule>): Snapshot => ({
  ...snapshot,
  packs: snapshot.packs.map((loaded) =>
    loaded.pack.id === "typescript"
      ? { ...loaded, pack: { ...loaded.pack, rules: rules.map(onText) } }
      : loaded,
  ),
});

/** A pack as listed and loaded, with nothing found by its loader. */
export const listed = (pack: Pack): LoadedPack => ({
  pack,
  load: { tools: [], outputs: new Map() },
});
