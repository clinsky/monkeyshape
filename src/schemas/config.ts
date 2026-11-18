/**
 * `shape.toml`: the one file where an adopting repo states its local facts, with kebab-case
 * keys; `shape.config.ts` states the same in camelCase until `mshape config migrate` replaces
 * it. Everything optional has a default in `resolveConfig`; the defaults are the template's
 * opinion, so overriding one should be rare and visible.
 */
import * as Schema from "effect/Schema";

/**
 * Every escape hatch carries a reason a later agent can weigh: 8 characters at least,
 * counted as JSON Schema counts them (code points), so the shipped schema says the same.
 */
const Reason = Schema.String.check(
  Schema.makeFilter((text: string) => [...text].length >= 8, {
    expected: "a reason of at least 8 characters",
    toJsonSchema: () => ({ minLength: 8 }),
  }),
);

const Globs = Schema.Array(Schema.String);

/** Every check `mshape check` runs, in the order it reports them. */
export const CHECK_NAMES = [
  "arch",
  "sources",
  "refs",
  "budgets",
  "coverage",
  "files",
  "rules",
  "packs",
  "skills",
  "sync",
  "beads",
] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/**
 * A glob that must match some file, or one that may not yet: `{ path, optional: true }`
 * names a layout still to come, and fails nothing while it matches nothing.
 */
const DeclaredGlob = Schema.Union([
  Schema.String,
  Schema.Struct({ path: Schema.String, optional: Schema.optionalKey(Schema.Boolean) }),
]);
type DeclaredGlob = typeof DeclaredGlob.Type;
const DeclaredGlobs = Schema.Array(DeclaredGlob);

/** Where a configured glob came from, so a glob matching nothing can be named. */
export interface Declared {
  readonly section: string;
  readonly glob: string;
  readonly optional: boolean;
}

const declared = (
  section: string,
  globs: ReadonlyArray<DeclaredGlob> | undefined,
): Array<Declared> =>
  (globs ?? []).map((glob) =>
    typeof glob === "string"
      ? { section, glob, optional: false }
      : { section, glob: glob.path, optional: glob.optional === true },
  );

const globsOf = (globs: ReadonlyArray<DeclaredGlob>): ReadonlyArray<string> =>
  globs.map((glob) => (typeof glob === "string" ? glob : glob.path));

/** A prerequisite is required unless the config says otherwise. */
const Requirement = Schema.Literals(["optional", "required"]);

export const Allowance = Schema.Struct({
  /** A glob, relative to the repo root. */
  path: Schema.String,
  reason: Reason,
});
export type Allowance = typeof Allowance.Type;

/** The language packs a repo can list, in `packs`; each owns its files, checks and stages. */
export const PACK_IDS = ["typescript", "rust", "python"] as const;
export type PackId = (typeof PACK_IDS)[number];
const Pack = Schema.Literals(PACK_IDS);

export const ModuleRule = Schema.Struct({
  description: Schema.String,
  /** The pack whose files the module holds: required when the repo lists more than one. */
  pack: Schema.optionalKey(Pack),
  /**
   * Where the module's files are, as repo-relative directories or files: for code that isn't
   * at `arch.root/<key>`, such as a crate at `crates/<name>`. Unset: `arch.root/<key>`.
   */
  paths: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMinLength(1)))),
  /** Modules this one may import besides itself. */
  mayImport: Schema.optionalKey(Schema.Array(Schema.String)),
  /** May touch the host directly (`node:*`, `bun`, platform packages). */
  hostAccess: Schema.optionalKey(Schema.Boolean),
  /** Third-party packages allowed here in addition to `arch.allowedPackages`. */
  packages: Schema.optionalKey(Schema.Array(Schema.String)),
  /** May import the package manifest (for the released version). */
  manifest: Schema.optionalKey(Schema.Boolean),
  /** Matching no file is not a failure: the module is still to come. */
  optional: Schema.optionalKey(Schema.Boolean),
}).pipe(Schema.encodeKeys({ mayImport: "may-import", hostAccess: "host-access" }));
export type ModuleRule = typeof ModuleRule.Type;

export const RuleSetting = Schema.Struct({
  /** Turning a rule off needs a reason, like any other escape hatch. */
  off: Schema.optionalKey(Reason),
  allow: Schema.optionalKey(Schema.Array(Allowance)),
});
export type RuleSetting = typeof RuleSetting.Type;

/** Every refs kind a repo can configure, as `refs.rules.<kind>`; the refs check reports them as `refs/<kind>`. */
export const REFS_KINDS = [
  "section-citation",
  "forbidden",
  "unknown-decision",
  "split-code-span",
  "normative-link",
  "unknown-script",
  "missing-path",
  "bead-in-code",
] as const;
export type RefsKind = (typeof REFS_KINDS)[number];

/** `off` and `allow` per refs kind, as `rules` takes them per rule; an unknown kind fails decoding. */
const RefsRules = Schema.Struct({
  "section-citation": Schema.optionalKey(RuleSetting),
  forbidden: Schema.optionalKey(RuleSetting),
  "unknown-decision": Schema.optionalKey(RuleSetting),
  "split-code-span": Schema.optionalKey(RuleSetting),
  "normative-link": Schema.optionalKey(RuleSetting),
  "unknown-script": Schema.optionalKey(RuleSetting),
  "missing-path": Schema.optionalKey(RuleSetting),
  "bead-in-code": Schema.optionalKey(RuleSetting),
} satisfies Record<RefsKind, unknown>);

/**
 * Repo-relative and already normal: segments joined by single `/`, none empty, `.` or `..`.
 * So `cases` and `data/large` pass; `/abs`, `../x`, `.`, `./x`, `data//large`, `cases/` don't.
 */
export const SharedPath = Schema.String.check(
  Schema.isPattern(/^(?!\.\.?(?:\/|$))[^/\0]+(?:\/(?!\.\.?(?:\/|$))[^/\0]+)*$/u, {
    message:
      "must be a repo-relative path written plainly: no leading `/` or `./`, no `.` or `..` segment, no `//` and no trailing `/` (write `vendor/x.tgz`, not `./vendor/x.tgz`)",
  }),
);

/**
 * A command that checks source monkeyshape doesn't analyze: `mshape check` runs it from the
 * repo root and reports its outcome. `files` are the globs it covers; it checks them itself.
 */
export const DeclaredCommand = Schema.Struct({
  files: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  /**
   * argv, not a shell line: `["make", "-C", "native", "check"]` or `["bun", "run", "check:c"]`.
   * An argument `"{files}"` becomes the files `files` matched, so it checks exactly those:
   * `["shellcheck", "{files}"]`.
   */
  run: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
  /**
   * Green when its program isn't installed here (a toolchain CI lacks), and when its files
   * match nothing. Otherwise both fail.
   */
  optional: Schema.optionalKey(Schema.Boolean),
});
export type DeclaredCommand = typeof DeclaredCommand.Type;

/** A release tarball of another repo, kept under `vendor/`: what `files` verifies it is. */
export const VendoredArtifact = Schema.Struct({
  /** Repo-relative and normal, as `sharedPaths` are, whatever its extension. */
  path: SharedPath,
  /** The npm name in the tarball's `package/package.json`. */
  package: Schema.String,
  /** Lowercase hex, as `sha256sum` prints it. */
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u)),
});
export type VendoredArtifact = typeof VendoredArtifact.Type;

export const ForbiddenPattern = Schema.Struct({
  /** A regular expression source, matched against docs and code comments. */
  pattern: Schema.String,
  reason: Reason,
});

/** argv, not a shell line: `["make", "-C", "native", "check"]`. */
const Argv = Schema.Array(Schema.String).check(Schema.isMinLength(1));

/** The gate's `mshape check` stage: always part of the gate, so no repo stage may take its name. */
export const CHECK_STAGE = "mshape-check";

/** One step of `mshape gate`: a pack's default, or the repo's own in `[gate].stages`. */
export const GateStage = Schema.Struct({
  /**
   * A repo stage with a pack stage's name replaces it. Lowercase words joined by hyphens: it
   * names the stage's log file, so no `/` or `..`.
   */
  name: Schema.String.check(
    Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, {
      message: "must be lowercase words joined by hyphens, such as `native-check`",
    }),
  ),
  run: Argv,
  /** Runs in the fast phase, the one `--fast` and `track pr` run. */
  fast: Schema.optionalKey(Schema.Boolean),
  /** The exit codes that pass; `[0]` when unset. */
  okExit: Schema.optionalKey(Schema.Array(Schema.Int).check(Schema.isMinLength(1))),
}).pipe(Schema.encodeKeys({ okExit: "ok-exit" }));
export type GateStage = typeof GateStage.Type;

/** The `mshape` a repo runs: the launcher fetches and verifies this version. */
const MshapePin = Schema.Struct({
  version: Schema.String.check(Schema.isPattern(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)),
  /** The sha256 of the release's `SHA256SUMS`, lowercase hex. */
  sums: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
  /** Run this argv instead of a fetched binary: monkeyshape's own repo, from source. */
  dev: Schema.optionalKey(Argv),
});

const LintLevel = Schema.Literals(["allow", "warn", "deny", "forbid"]);

/** One lint as Cargo's `[lints]` tables write it: a level, or a level with a priority. */
const LintSetting = Schema.Union([
  LintLevel,
  Schema.Struct({ level: LintLevel, priority: Schema.Int }),
]);

/** Lints by name, as Cargo writes them (`dbg_macro`): Cargo's keys, not monkeyshape's. */
const LintTable = Schema.Record(Schema.String, LintSetting);

/** What only the Rust pack reads. */
const RustTable = Schema.Struct({
  /**
   * Laid over the curated workspace lints, lint by lint, in the `[workspace.lints.*]` tables
   * `mshape sync` writes into the root `Cargo.toml`.
   */
  lints: Schema.optionalKey(
    Schema.Struct({
      rust: Schema.optionalKey(LintTable),
      clippy: Schema.optionalKey(LintTable),
    }),
  ),
});

/** What only the Python pack reads. */
const PythonTable = Schema.Struct({
  /**
   * Laid over the curated ty rules, rule by rule, in the `[tool.ty.rules]` table `mshape sync`
   * writes into the root `pyproject.toml`. Keys are ty's rule names.
   */
  tyRules: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Literals(["ignore", "warn", "error"])),
  ),
}).pipe(Schema.encodeKeys({ tyRules: "ty-rules" }));

const configFields = {
  /** The packs, in the order their gate stages run. */
  packs: Schema.optionalKey(Schema.Array(Pack).check(Schema.isMinLength(1))),
  mshape: Schema.optionalKey(MshapePin),
  rust: Schema.optionalKey(RustTable),
  python: Schema.optionalKey(PythonTable),
  /** The repo's own gate stages, after its packs' defaults. */
  gate: Schema.optionalKey(Schema.Struct({ stages: Schema.optionalKey(Schema.Array(GateStage)) })),
  layers: Schema.optionalKey(Schema.Array(Schema.Literals(["core", "agentic"]))),
  /**
   * Files the custom rules apply to. Every other TypeScript file is a test, a declaration
   * file, or in `exempt` with a reason; the `sources` check fails on any that is none of them.
   */
  sources: Schema.optionalKey(
    Schema.Struct({
      include: Schema.optionalKey(DeclaredGlobs),
      exclude: Schema.optionalKey(DeclaredGlobs),
      exempt: Schema.optionalKey(Schema.Array(Allowance)),
    }),
  ),
  /** Composition roots: where effects run and the host's clock, env and timers may be read. */
  entry: Schema.optionalKey(DeclaredGlobs),
  /** A whole check turned off, with the reason. Its line in `mshape check` says `exempt`. */
  checks: Schema.optionalKey(
    Schema.Struct(
      Object.fromEntries(
        CHECK_NAMES.map((name) => [name, Schema.optionalKey(Schema.Struct({ off: Reason }))]),
      ) as { readonly [C in CheckName]: Schema.optionalKey<Schema.Struct<{ off: typeof Reason }>> },
    ),
  ),
  /**
   * The tools `coverage` asks. Required by default: a missing or broken one fails the gate.
   * `optional` falls back to reading their configs when the tool isn't installed, with a note.
   */
  prerequisites: Schema.optionalKey(
    Schema.Struct({
      tsc: Schema.optionalKey(Requirement),
      biome: Schema.optionalKey(Requirement),
    }),
  ),
  arch: Schema.optionalKey(
    Schema.Struct({
      root: Schema.optionalKey(Schema.String),
      modules: Schema.Record(Schema.String, ModuleRule),
      /** Third-party packages every module may import, in addition to `effect`. */
      allowedPackages: Schema.optionalKey(Schema.Array(Schema.String)),
      hostSpecifiers: Schema.optionalKey(Schema.Array(Schema.String)),
    }).pipe(
      Schema.encodeKeys({ allowedPackages: "allowed-packages", hostSpecifiers: "host-specifiers" }),
    ),
  ),
  rules: Schema.optionalKey(Schema.Record(Schema.String, RuleSetting)),
  /** `required` fails the check when bd can't answer, so a green CI run means beads was checked. */
  beads: Schema.optionalKey(Schema.Literals(["optional", "required"])),
  tracks: Schema.optionalKey(
    Schema.Struct({
      /**
       * Gitignored paths every track worktree shares with the main checkout, such as a large
       * dataset: repo-relative, no `..`. `mshape track new` links `<worktree>/<path>` to
       * `<main>/<path>`. The semantics are in plan/MILESTONE.md, "Interfaces the tracks share".
       */
      sharedPaths: Schema.optionalKey(Schema.Array(SharedPath)),
    }).pipe(Schema.encodeKeys({ sharedPaths: "shared-paths" })),
  ),
  refs: Schema.optionalKey(
    Schema.Struct({
      docs: Schema.optionalKey(Globs),
      /** Docs that are not normative (may link into notes/, plan/, handoffs). */
      narrativeDocs: Schema.optionalKey(Globs),
      /**
       * Docs held to form only (one-line code spans, no `§N` citations, no `forbidden` text), never to whether a
       * path, script or decision exists: plans describe what doesn't exist yet, notes are
       * history. Wins over `docs`.
       */
      formOnlyDocs: Schema.optionalKey(Globs),
      forbidden: Schema.optionalKey(Schema.Array(ForbiddenPattern)),
      /** Per kind, as `rules` per rule: `off` with a reason, or `allow` for paths with reasons. */
      rules: Schema.optionalKey(RefsRules),
    }).pipe(Schema.encodeKeys({ narrativeDocs: "narrative-docs", formOnlyDocs: "form-only-docs" })),
  ),
  budgets: Schema.optionalKey(
    Schema.Struct({
      agentsLines: Schema.optionalKey(Schema.Int),
      readmeLines: Schema.optionalKey(Schema.Int),
      decisions: Schema.optionalKey(Schema.Int),
      decisionWords: Schema.optionalKey(Schema.Int),
      memories: Schema.optionalKey(Schema.Int),
      memoryBytes: Schema.optionalKey(Schema.Int),
      fileWarnLines: Schema.optionalKey(Schema.Int),
      fileFailLines: Schema.optionalKey(Schema.Int),
      largeFiles: Schema.optionalKey(Schema.Array(Allowance)),
    }).pipe(
      Schema.encodeKeys({
        agentsLines: "agents-lines",
        readmeLines: "readme-lines",
        decisionWords: "decision-words",
        memoryBytes: "memory-bytes",
        fileWarnLines: "file-warn-lines",
        fileFailLines: "file-fail-lines",
        largeFiles: "large-files",
      }),
    ),
  ),
  files: Schema.optionalKey(
    Schema.Struct({
      /** The size cap for every file in the repo, in bytes. */
      maxBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      /** Files allowed past the cap, each with its reason. */
      large: Schema.optionalKey(Schema.Array(Allowance)),
      vendored: Schema.optionalKey(Schema.Array(VendoredArtifact)),
    }).pipe(Schema.encodeKeys({ maxBytes: "max-bytes" })),
  ),
  coverage: Schema.optionalKey(
    Schema.Struct({
      tsconfigs: Schema.optionalKey(Schema.Array(Schema.String)),
      biome: Schema.optionalKey(Schema.String),
      /** Path segments whose files need not be typechecked or linted (generated, vendored). */
      exempt: Schema.optionalKey(Schema.Array(Schema.String)),
      commands: Schema.optionalKey(Schema.Array(DeclaredCommand)),
      /** Executable source no command checks, each with the reason it needs none. */
      exemptFiles: Schema.optionalKey(Schema.Array(Allowance)),
    }).pipe(Schema.encodeKeys({ exemptFiles: "exempt-files" })),
  ),
};

/** `shape.toml` as written: kebab-case keys, decoded into the camelCase `ShapeConfig`. */
export const ShapeToml = Schema.Struct(configFields);

/** `shape.config.ts`'s default export: the same values in camelCase, plus `localRules`. */
export const ShapeConfig = Schema.toType(
  Schema.Struct({
    ...configFields,
    /**
     * The repo's own rules: each a module's default export, imported here
     * (`import indexWrites from "./rules/indexWrites.ts"`). The rules check validates each and
     * runs it as `local/<id>`; `rules` configures it under that id.
     */
    localRules: Schema.optionalKey(Schema.Array(Schema.Unknown)),
  }),
);
export type ShapeConfig = typeof ShapeConfig.Type;

/**
 * What the schema can't say about one `shape.toml`, each naming its key: a module without a
 * pack where the repo lists several, a pack a module names but `packs` doesn't, a pack or
 * gate stage listed twice. `packs` missing is the loader's, which can say what to list.
 */
export const configProblems = (config: ShapeConfig): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const packs = config.packs ?? [];
  for (const pack of new Set(packs.filter((one, i) => packs.indexOf(one) !== i)))
    problems.push(`packs: lists \`${pack}\` twice; list each pack once`);
  for (const [name, module] of Object.entries(config.arch?.modules ?? {})) {
    if (module.pack === undefined && packs.length > 1)
      problems.push(
        `arch.modules.${name}: the repo lists ${packs.length} packs (${packs.join(", ")}), so say whose files the module holds: \`pack = "${packs[0]}"\` or another of them`,
      );
    if (module.pack !== undefined && packs.length > 0 && !packs.includes(module.pack))
      problems.push(
        `arch.modules.${name}.pack: \`${module.pack}\` isn't in \`packs\` (${packs.join(", ")}); add it there or name one of those`,
      );
  }
  const stages = (config.gate?.stages ?? []).map((stage) => stage.name);
  if (stages.includes(CHECK_STAGE))
    problems.push(
      `gate.stages: \`${CHECK_STAGE}\` is the gate's own \`mshape check\`, which always runs and can't be replaced; give the stage another name`,
    );
  for (const name of new Set(stages.filter((one, i) => stages.indexOf(one) !== i)))
    problems.push(
      `gate.stages: two stages are named \`${name}\`; give each its own name (one with a pack stage's name replaces that stage)`,
    );
  return problems;
};

/** The JSON Schema of `shape.toml` that editors validate against, shipped as `schema/shape.schema.json`. */
export const shapeJsonSchema = (): string => {
  const document = Schema.toJsonSchemaDocument(ShapeToml);
  // Effect leaves objects open; the loader refuses an unknown key, so the editor should too.
  const close = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(close);
    if (typeof node !== "object" || node === null) return node;
    const out: Record<string, unknown> & { additionalProperties?: unknown } = {};
    for (const [key, value] of Object.entries(node)) out[key] = close(value);
    if ("properties" in out && out.additionalProperties === true) out.additionalProperties = false;
    return out;
  };
  const root = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "shape.toml",
    description: "monkeyshape's config: https://github.com/clinsky/monkeyshape",
    ...(close(document.schema) as object),
    ...(Object.keys(document.definitions).length > 0 ? { $defs: close(document.definitions) } : {}),
  };
  return `${JSON.stringify(root, null, 2)}\n`;
};

export interface ResolvedConfig {
  /** The config file as its reader names it: `shape.toml`, or what `--config` loaded. */
  readonly configFile: string;
  /** In the order their gate stages run; `["typescript"]` for a `shape.config.ts`. */
  readonly packs: ReadonlyArray<PackId>;
  readonly mshape:
    | { readonly version: string; readonly sums?: string; readonly dev?: ReadonlyArray<string> }
    | undefined;
  /** The `[rust]` table, as written; only the Rust pack reads it. */
  readonly rust: typeof RustTable.Type | undefined;
  /** The `[python]` table, as written; only the Python pack reads it. */
  readonly python: typeof PythonTable.Type | undefined;
  readonly gate: { readonly stages: ReadonlyArray<GateStage> };
  /**
   * The repo's files the config imports, directly or not: its local rules and their helpers.
   * Like the config, they are mshape's, so arch asks no module to own them.
   */
  readonly configModules: ReadonlyArray<string>;
  readonly layers: ReadonlyArray<"core" | "agentic">;
  readonly sources: {
    readonly include: ReadonlyArray<string>;
    readonly exclude: ReadonlyArray<string>;
    readonly exempt: ReadonlyArray<Allowance>;
  };
  readonly entry: ReadonlyArray<string>;
  /**
   * The globs the config wrote itself (not defaults): each must match a file unless optional.
   * `sources.exclude` isn't held to it: an exclude that matches nothing hides nothing.
   */
  readonly declared: ReadonlyArray<Declared>;
  readonly checks: { readonly [C in CheckName]?: { readonly off: string } };
  readonly prerequisites: {
    readonly tsc: "optional" | "required";
    readonly biome: "optional" | "required";
  };
  readonly beads: "optional" | "required";
  readonly tracks: { readonly sharedPaths: ReadonlyArray<string> };
  readonly arch:
    | {
        readonly root: string;
        readonly modules: Readonly<Record<string, ModuleRule>>;
        readonly allowedPackages: ReadonlyArray<string>;
        /** As the config sets them; unset, each pack's own `hostSpecifiers` apply to its files. */
        readonly hostSpecifiers: ReadonlyArray<string> | undefined;
      }
    | undefined;
  readonly rules: Readonly<
    Record<string, { readonly off?: string; readonly allow?: ReadonlyArray<Allowance> }>
  >;
  /** Validated by the rules check, not here, so a misshaped one fails the gate with a reason. */
  readonly localRules: ReadonlyArray<unknown>;
  readonly refs: {
    readonly docs: ReadonlyArray<string>;
    readonly narrativeDocs: ReadonlyArray<string>;
    readonly formOnlyDocs: ReadonlyArray<string>;
    readonly forbidden: ReadonlyArray<{ readonly pattern: string; readonly reason: string }>;
    readonly rules: Readonly<Partial<Record<RefsKind, RuleSetting>>>;
  };
  readonly budgets: {
    readonly agentsLines: number;
    readonly readmeLines: number;
    readonly decisions: number;
    readonly decisionWords: number;
    readonly memories: number;
    readonly memoryBytes: number;
    readonly fileWarnLines: number;
    readonly fileFailLines: number;
    readonly largeFiles: ReadonlyArray<Allowance>;
  };
  readonly files: {
    readonly maxBytes: number;
    readonly large: ReadonlyArray<Allowance>;
    readonly vendored: ReadonlyArray<VendoredArtifact>;
  };
  readonly coverage: {
    readonly tsconfigs: ReadonlyArray<string>;
    readonly biome: string;
    readonly exempt: ReadonlyArray<string>;
    readonly commands: ReadonlyArray<DeclaredCommand>;
    readonly exemptFiles: ReadonlyArray<Allowance>;
  };
}

export const DEFAULT_DOCS: ReadonlyArray<string> = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "DECISIONS.md",
  "skills/**/*.md",
  ".agents/skills/**/*.md",
  ".claude/skills/**/*.md",
  ".github/pull_request_template.md",
];

/** `./src/`, `src/` and `src` are one root; `./`, `.` and `` are the repo root, `.`. */
const normalRoot = (root: string): string =>
  root.replace(/^(\.\/)+/, "").replace(/\/+$/, "") || ".";

/** TypeScript's: `sources.include` when neither the config nor the packs say otherwise. */
const TS_SOURCES = ["src/**/*.{ts,tsx}", "tools/**/*.{ts,tsx}"];

/**
 * `file`: the config as its reader names it, where findings about the config point.
 * `packSources`: each listed pack's `sources.include` default, by id; the loader passes them,
 * since the packs, not the schema, know their languages.
 */
export const resolveConfig = (
  config: ShapeConfig,
  file = "shape.config.ts",
  modules: ReadonlyArray<string> = [],
  packSources: Readonly<Partial<Record<PackId, ReadonlyArray<string>>>> = {
    typescript: TS_SOURCES,
  },
): ResolvedConfig => ({
  configFile: file,
  packs: config.packs ?? ["typescript"],
  mshape: config.mshape,
  rust: config.rust,
  python: config.python,
  gate: { stages: config.gate?.stages ?? [] },
  configModules: modules,
  layers: config.layers ?? ["core"],
  sources: {
    include: globsOf(
      config.sources?.include ??
        (config.packs ?? ["typescript"]).flatMap((pack) => packSources[pack] ?? []),
    ),
    // An exempt file is counted, never analyzed: excluding it here keeps the rules engine,
    // and any later reader of `sources`, from analyzing it.
    exclude: [
      ...globsOf(config.sources?.exclude ?? ["**/*.test.ts", "**/*.test.tsx"]),
      ...(config.sources?.exempt ?? []).map((allowance) => allowance.path),
      // monkeyshape's own config is data for mshape, even under a root glob like `*.ts`.
      "shape.config.ts",
    ],
    exempt: config.sources?.exempt ?? [],
  },
  entry: globsOf(config.entry ?? ["src/cli/**", "tools/**"]),
  declared: [
    ...declared("sources.include", config.sources?.include),
    ...declared(
      "sources.exempt",
      config.sources?.exempt?.map((allowance) => allowance.path),
    ),
    ...declared("entry", config.entry),
  ],
  checks: config.checks ?? {},
  prerequisites: {
    tsc: config.prerequisites?.tsc ?? "required",
    biome: config.prerequisites?.biome ?? "required",
  },
  beads: config.beads ?? "optional",
  tracks: { sharedPaths: config.tracks?.sharedPaths ?? [] },
  arch:
    config.arch === undefined
      ? undefined
      : {
          root: normalRoot(config.arch.root ?? "src"),
          modules: config.arch.modules,
          allowedPackages: [...new Set(["effect", ...(config.arch.allowedPackages ?? [])])],
          hostSpecifiers: config.arch.hostSpecifiers,
        },
  rules: config.rules ?? {},
  localRules: config.localRules ?? [],
  refs: {
    docs: config.refs?.docs ?? DEFAULT_DOCS,
    narrativeDocs: config.refs?.narrativeDocs ?? ["README.md"],
    formOnlyDocs: config.refs?.formOnlyDocs ?? ["plan/**/*.md", "notes/**/*.md"],
    forbidden: config.refs?.forbidden ?? [],
    rules: config.refs?.rules ?? {},
  },
  budgets: {
    agentsLines: config.budgets?.agentsLines ?? 150,
    readmeLines: config.budgets?.readmeLines ?? 100,
    decisions: config.budgets?.decisions ?? 15,
    decisionWords: config.budgets?.decisionWords ?? 150,
    memories: config.budgets?.memories ?? 12,
    memoryBytes: config.budgets?.memoryBytes ?? 6144,
    fileWarnLines: config.budgets?.fileWarnLines ?? 600,
    fileFailLines: config.budgets?.fileFailLines ?? 1200,
    largeFiles: config.budgets?.largeFiles ?? [],
  },
  coverage: {
    tsconfigs: config.coverage?.tsconfigs ?? ["tsconfig.json"],
    biome: config.coverage?.biome ?? "biome.json",
    exempt: config.coverage?.exempt ?? [
      "node_modules",
      "dist",
      "out",
      "build",
      "coverage",
      "vendor",
      "generated",
    ],
    commands: config.coverage?.commands ?? [],
    exemptFiles: config.coverage?.exemptFiles ?? [],
  },
  files: {
    maxBytes: config.files?.maxBytes ?? 1024 * 1024,
    large: config.files?.large ?? [],
    vendored: config.files?.vendored ?? [],
  },
});
