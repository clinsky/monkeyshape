/**
 * The language-pack interface. A pack is a pure value here, in `src/packs/<id>/`, and a loader
 * in `src/adapters/packs/<id>.ts` that runs its toolchain (D-pure-checks). The core runs every
 * pack the repo lists; nothing in it names a language.
 *
 * A pack says which files are its own (`kindOf`), reads their comments, and contributes rules,
 * base configs, an init template and gate stages. Its loader returns what the toolchain saw:
 * which files each tool covers, and the raw output the pure part reads (`cargo metadata`'s
 * JSON). From that and the files' texts, `graph` builds the edges `arch` judges, resolved to
 * repo paths: parsing lives here, so a test feeds it recorded output instead of a toolchain.
 */
import type * as Effect from "effect/Effect";
import type { CheckName, Integration, Snapshot } from "../core/model.ts";
import type { GateStage, PackId, ResolvedConfig } from "../schemas/config.ts";

/**
 * What a claimed file is to the pack. `source` is code the rules, `arch` and coverage hold;
 * a `test` is checked by the tools but layered by no module; a `declaration` (a `.d.ts`)
 * describes code and is neither.
 */
export type FileKind = "source" | "test" | "declaration";

/** One comment as its file holds it: `shape-ignore` reads line comments, `refs` reads both. */
export interface Comment {
  readonly kind: "line" | "block";
  /** The text between the markers, as written. */
  readonly text: string;
  /** UTF-16 offsets into the file's text, as every offset here is. */
  readonly start: number;
  readonly end: number;
}

/** A file the rules engine runs a pack's rules over. */
export interface SourceText {
  /** Repo-relative, `/`-separated. */
  readonly path: string;
  readonly text: string;
}

export interface Finding {
  /** UTF-16 offset into the file's text; the engine turns it into a line. */
  readonly offset: number;
  /** Overrides the rule's message for this finding. */
  readonly message?: string;
}

/**
 * A pack's own rule, run by the one engine: scope, allowances, `shape-ignore` (in the pack's
 * comment syntax) and baselines are the engine's, so a rule only reports offsets. Reported as
 * `rules/<id>`; ids are unique across every pack and the engine's own kinds.
 */
export interface PackRule {
  readonly id: string;
  readonly layer: "core" | "agentic";
  /** The class of bug this rule removes, for `mshape rules`. */
  readonly bugClass: string;
  /** Why, and what to do instead. Shown with every violation. */
  readonly message: string;
  /** Whether composition roots (`entry`) are exempt. */
  readonly entryExempt: boolean;
  /**
   * The findings in one file. `files` is every source the snapshot read, for a rule that
   * follows an import into another file.
   */
  readonly run: (file: SourceText, files: ReadonlyMap<string, string>) => ReadonlyArray<Finding>;
}

/**
 * One dependency `arch` judges, from a repo file to another, a package, or the package
 * manifest. Both ends of a `to` edge are mapped to modules by path whatever `kindOf` says of
 * them, so a node may be any repo file: a TypeScript source, or a crate's `Cargo.toml`. Test edges (a dev-dependency, a
 * test file's imports) are left out by the pack: arch layers code, not tests.
 */
export type Edge = {
  readonly from: string;
  /** 1-based; where the dependency is written. */
  readonly line: number;
  /** As written (`../core/model.ts`, `serde`), for the message. */
  readonly written: string;
} & (
  | { readonly to: string }
  | { readonly package: string }
  /** The repo's manifest (`package.json`): allowed where the module sets `manifest`. */
  | { readonly manifest: string }
  /** A dependency the pack couldn't resolve to a file or package: `arch/unresolved-import`. */
  | { readonly unresolved: string }
);

/** A use of the host in a file (a host global, a host module, `std::fs`), for `host-access`. */
export interface HostUse {
  readonly file: string;
  readonly line: number;
  /** What it does, completing "<what>, but module 'x' has no hostAccess". */
  readonly what: string;
}

/** The files one tool processes, as the tool itself reports them, and how it fared. */
export interface ToolRun {
  /** One of the pack's `tools`. */
  readonly tool: string;
  readonly integration: Integration;
  /** Undefined unless `integration` is ok. */
  readonly files: ReadonlySet<string> | undefined;
}

/** What a pack's loader found: one entry per listed pack in `Snapshot.packs`. */
export interface PackLoad {
  readonly tools: ReadonlyArray<ToolRun>;
  /** Raw tool output the pure part reads, by a name the pack chooses (`cargo metadata`). */
  readonly outputs: ReadonlyMap<string, string>;
}

/** What `graph` reads: the repo's files and texts, and its own loader's output. */
export interface GraphInput {
  readonly config: ResolvedConfig;
  /** The pack's sources `arch` layers; a pack may start edges at other repo files too. */
  readonly files: ReadonlyArray<string>;
  /** Every file in the repo, for resolving a dependency to one that exists. */
  readonly known: ReadonlySet<string>;
  readonly texts: Snapshot["texts"];
  readonly outputs: PackLoad["outputs"];
  /** Whether a specifier names the host, from `arch.host-specifiers` or the pack's default. */
  readonly isHost: (specifier: string) => boolean;
}

export interface Graph {
  readonly edges: ReadonlyArray<Edge>;
  readonly hostUses: ReadonlyArray<HostUse>;
}

/**
 * A finding of the pack's own that isn't a rule over one source's text (a crate without
 * `[lints] workspace = true`). Reported by the `packs` check as `packs/<id>/<kind>`, every kind
 * listed in the pack's `findingKinds` so test/core/ruleCases.test.ts covers it.
 */
export interface PackFinding {
  readonly kind: string;
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

/** A tool whose file list coverage holds every claimed source to. */
export interface Tool {
  /** `tsc`, `biome`, `rustc`: named in coverage's messages and in `prerequisites/*`. */
  readonly name: string;
  /** Why a file it misses is missed and how to fix it, completing "<file> <uncovered>". */
  readonly uncovered: (config: ResolvedConfig) => string;
  /**
   * Whether the tool's config covers a file, read without the tool, for when it couldn't run
   * and the repo set it optional. Undefined: coverage can't judge without the tool.
   */
  readonly approximate?: (
    config: ResolvedConfig,
    snapshot: Snapshot,
  ) => ((file: string) => boolean) | undefined;
}

/**
 * How a base config reaches a repo. `extends`: the repo's config names the shipped file (a
 * tsconfig's `extends`, biome's). `copy`: `mshape sync` writes it to `.mshape/<name>` and the
 * `sync` check holds it equal; the repo's config points at it. `table`: `sync` owns these
 * TOML tables inside a repo file (Cargo's `[workspace.lints]`) and the check compares them.
 */
export type BaseConfig =
  | { readonly delivery: "extends"; readonly shipped: string; readonly pointer: Pointer }
  | {
      readonly delivery: "copy";
      readonly shipped: string;
      /** Under `.mshape/`. */
      readonly target: string;
      readonly pointer: Pointer;
    }
  | {
      readonly delivery: "table";
      readonly file: string;
      /** Dotted paths of the tables `sync` owns, e.g. `workspace.lints.clippy`. */
      readonly tables: ReadonlyArray<string>;
      /** The tables' content, from the shipped config and the repo's own overrides. */
      readonly content: (config: ResolvedConfig) => string;
    };

/** Where a repo's config must point at a base config: `extend` in `ruff.toml`. */
export interface Pointer {
  readonly file: string;
  readonly key: string;
}

/** A program a pack needs. A required one missing fails its checks and stages. */
export interface Prerequisite {
  readonly name: string;
  readonly required: boolean;
  /** How to install it, for a message an agent can act on unaided. */
  readonly install: string;
}

/** The pure part of a pack: data and functions over text, no I/O. */
export interface Pack {
  readonly id: PackId;
  /** What a file is to this pack, or undefined when the pack doesn't claim it. */
  readonly kindOf: (file: string) => FileKind | undefined;
  /** The language, in words, for messages: "TypeScript", "Rust". */
  readonly language: string;
  /** Every comment in a claimed file, in order. */
  readonly comments: (file: SourceText) => ReadonlyArray<Comment>;
  /** `sources` when the config sets none, e.g. `["src/**\/*.{ts,tsx}"]`. */
  readonly defaultSources: { readonly include: ReadonlyArray<string> };
  /** `arch.host-specifiers` when the config sets none: what counts as the host. */
  readonly hostSpecifiers: ReadonlyArray<string>;
  /** The edges and host uses `arch` judges, over the files it layers. */
  readonly graph: (input: GraphInput) => Graph;
  readonly tools: ReadonlyArray<Tool>;
  /** The pack's own findings over the repo, pure: its texts and its loader's output. */
  readonly findings: (input: {
    readonly config: ResolvedConfig;
    readonly snapshot: Snapshot;
    readonly load: PackLoad | undefined;
  }) => ReadonlyArray<PackFinding>;
  readonly findingKinds: ReadonlyArray<string>;
  readonly rules: ReadonlyArray<PackRule>;
  /** Why a claimed source doesn't parse, for `rules/syntax`; none when it does. */
  readonly syntaxErrors: (file: SourceText) => ReadonlyArray<string>;
  readonly baseConfigs: ReadonlyArray<BaseConfig>;
  /** `template/packs/<id>/`, laid over `template/common/` by `init --pack <id>`. */
  readonly template: string;
  /** The pack's default gate stages, in order; `fast` marks phase 1's. */
  readonly stages: ReadonlyArray<GateStage>;
  readonly prerequisites: ReadonlyArray<Prerequisite>;
  /** The checks this pack's loader must run for: the rest load without it. */
  readonly loadFor: ReadonlyArray<CheckName>;
}

/**
 * The loader, in `src/adapters/packs/<id>.ts`: runs the toolchain over the files the pack
 * claims and returns what it saw. Never fails: a tool that can't run is an integration state.
 * `snapshot` holds every file and the texts read; `checks` are the checks this run selected,
 * so a slow tool runs only when one needs it.
 */
export type PackLoader = (input: {
  readonly root: string;
  readonly config: ResolvedConfig;
  readonly files: ReadonlyArray<string>;
  readonly texts: Snapshot["texts"];
  readonly checks: ReadonlyArray<CheckName>;
}) => Effect.Effect<PackLoad>;
