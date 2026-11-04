/**
 * `shape.config.ts`: the one file where an adopting repo states its local facts.
 * Everything optional has a default in `resolveConfig`; the defaults are the template's
 * opinion, so overriding one should be rare and visible.
 */
import { Schema } from "effect";

/** Every escape hatch carries a reason a later agent can weigh. */
const Reason = Schema.String.check(Schema.isMinLength(8));

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

export const ModuleRule = Schema.Struct({
  description: Schema.String,
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
});
export type ModuleRule = typeof ModuleRule.Type;

export const RuleSetting = Schema.Struct({
  /** Turning a rule off needs a reason, like any other escape hatch. */
  off: Schema.optionalKey(Reason),
  allow: Schema.optionalKey(Schema.Array(Allowance)),
});

/**
 * Repo-relative and already normal: segments joined by single `/`, none empty, `.` or `..`.
 * So `cases` and `data/large` pass; `/abs`, `../x`, `.`, `./x`, `data//large`, `cases/` don't.
 */
export const SharedPath = Schema.String.check(
  Schema.isPattern(/^(?!\.\.?(?:\/|$))[^/\0]+(?:\/(?!\.\.?(?:\/|$))[^/\0]+)*$/, {
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
  /** argv, not a shell line: `["make", "-C", "native", "check"]` or `["bun", "run", "check:c"]`. */
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
  sha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
});
export type VendoredArtifact = typeof VendoredArtifact.Type;

export const ForbiddenPattern = Schema.Struct({
  /** A regular expression source, matched against docs and code comments. */
  pattern: Schema.String,
  reason: Reason,
});

export const ShapeConfig = Schema.Struct({
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
      allowedPackages: Schema.optionalKey(Schema.Array(Schema.String)),
      hostSpecifiers: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  rules: Schema.optionalKey(Schema.Record(Schema.String, RuleSetting)),
  /**
   * The repo's own rules: each a module's default export, imported here
   * (`import indexWrites from "./rules/indexWrites.ts"`). The rules check validates each and
   * runs it as `local/<id>`; `rules` configures it under that id.
   */
  localRules: Schema.optionalKey(Schema.Array(Schema.Unknown)),
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
    }),
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
    }),
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
    }),
  ),
  files: Schema.optionalKey(
    Schema.Struct({
      /** The size cap for every file in the repo, in bytes. */
      maxBytes: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
      /** Files allowed past the cap, each with its reason. */
      large: Schema.optionalKey(Schema.Array(Allowance)),
      vendored: Schema.optionalKey(Schema.Array(VendoredArtifact)),
    }),
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
    }),
  ),
});
export type ShapeConfig = typeof ShapeConfig.Type;

export interface ResolvedConfig {
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
        readonly hostSpecifiers: ReadonlyArray<string>;
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

export const resolveConfig = (config: ShapeConfig): ResolvedConfig => ({
  layers: config.layers ?? ["core"],
  sources: {
    include: globsOf(config.sources?.include ?? ["src/**/*.{ts,tsx}", "tools/**/*.{ts,tsx}"]),
    // An exempt file is counted, never analyzed: excluding it here keeps the rules engine,
    // and any later reader of `sources`, from analyzing it.
    exclude: [
      ...globsOf(config.sources?.exclude ?? ["**/*.test.ts", "**/*.test.tsx"]),
      ...(config.sources?.exempt ?? []).map((allowance) => allowance.path),
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
          root: config.arch.root ?? "src",
          modules: config.arch.modules,
          allowedPackages: config.arch.allowedPackages ?? ["effect"],
          hostSpecifiers: config.arch.hostSpecifiers ?? [
            "bun",
            "bun:*",
            "node:*",
            "@effect/platform-*",
          ],
        },
  rules: config.rules ?? {},
  localRules: config.localRules ?? [],
  refs: {
    docs: config.refs?.docs ?? DEFAULT_DOCS,
    narrativeDocs: config.refs?.narrativeDocs ?? ["README.md"],
    formOnlyDocs: config.refs?.formOnlyDocs ?? ["plan/**/*.md", "notes/**/*.md"],
    forbidden: config.refs?.forbidden ?? [],
  },
  budgets: {
    agentsLines: config.budgets?.agentsLines ?? 150,
    readmeLines: config.budgets?.readmeLines ?? 80,
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
