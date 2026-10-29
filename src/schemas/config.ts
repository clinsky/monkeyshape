/**
 * `shape.config.ts`: the one file where an adopting repo states its local facts.
 * Everything optional has a default in `resolveConfig`; the defaults are the template's
 * opinion, so overriding one should be rare and visible.
 */
import { Schema } from "effect";

/** Every escape hatch carries a reason a later agent can weigh. */
const Reason = Schema.String.check(Schema.isMinLength(8));

const Globs = Schema.Array(Schema.String);

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
});
export type ModuleRule = typeof ModuleRule.Type;

export const RuleSetting = Schema.Struct({
  /** Turning a rule off needs a reason, like any other escape hatch. */
  off: Schema.optionalKey(Reason),
  allow: Schema.optionalKey(Schema.Array(Allowance)),
});

export const ForbiddenPattern = Schema.Struct({
  /** A regular expression source, matched against docs and code comments. */
  pattern: Schema.String,
  reason: Reason,
});

export const ShapeConfig = Schema.Struct({
  layers: Schema.optionalKey(Schema.Array(Schema.Literals(["core", "agentic"]))),
  /** Files the custom rules apply to. Tests are out by default: they may throw and run effects. */
  sources: Schema.optionalKey(
    Schema.Struct({ include: Schema.optionalKey(Globs), exclude: Schema.optionalKey(Globs) }),
  ),
  /** Composition roots: where effects run and the host's clock, env and timers may be read. */
  entry: Schema.optionalKey(Globs),
  arch: Schema.optionalKey(
    Schema.Struct({
      root: Schema.optionalKey(Schema.String),
      modules: Schema.Record(Schema.String, ModuleRule),
      allowedPackages: Schema.optionalKey(Schema.Array(Schema.String)),
      hostSpecifiers: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
  rules: Schema.optionalKey(Schema.Record(Schema.String, RuleSetting)),
  /** `required` fails the check when bd can't answer, so a green CI run means beads was checked. */
  beads: Schema.optionalKey(Schema.Literals(["optional", "required"])),
  refs: Schema.optionalKey(
    Schema.Struct({
      docs: Schema.optionalKey(Globs),
      /** Docs that are not normative (may link into notes/, plan/, handoffs). */
      narrativeDocs: Schema.optionalKey(Globs),
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
  coverage: Schema.optionalKey(
    Schema.Struct({
      tsconfigs: Schema.optionalKey(Schema.Array(Schema.String)),
      biome: Schema.optionalKey(Schema.String),
      /** Path segments whose files need not be typechecked or linted (generated, vendored). */
      exempt: Schema.optionalKey(Schema.Array(Schema.String)),
    }),
  ),
});
export type ShapeConfig = typeof ShapeConfig.Type;

export interface ResolvedConfig {
  readonly layers: ReadonlyArray<"core" | "agentic">;
  readonly sources: {
    readonly include: ReadonlyArray<string>;
    readonly exclude: ReadonlyArray<string>;
  };
  readonly entry: ReadonlyArray<string>;
  readonly beads: "optional" | "required";
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
  readonly refs: {
    readonly docs: ReadonlyArray<string>;
    readonly narrativeDocs: ReadonlyArray<string>;
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
  readonly coverage: {
    readonly tsconfigs: ReadonlyArray<string>;
    readonly biome: string;
    readonly exempt: ReadonlyArray<string>;
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
    include: config.sources?.include ?? ["src/**/*.{ts,tsx}", "tools/**/*.{ts,tsx}"],
    exclude: config.sources?.exclude ?? ["**/*.test.ts", "**/*.test.tsx"],
  },
  entry: config.entry ?? ["src/cli/**", "tools/**"],
  beads: config.beads ?? "optional",
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
  refs: {
    docs: config.refs?.docs ?? DEFAULT_DOCS,
    narrativeDocs: config.refs?.narrativeDocs ?? ["README.md"],
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
  },
});
