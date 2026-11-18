/**
 * The language-pack interface. A pack is a pure value here, in `src/packs/<id>/`, and a loader
 * in `src/adapters/packs/<id>.ts` that runs its toolchain (D-pure-checks). The core runs every
 * pack the repo lists; nothing in it names a language.
 *
 * A pack says which files are its own (`kindOf`), reads their comments, and contributes rules,
 * base configs, an init template and gate stages. Its loader returns what the toolchain sees:
 * which files each tool covers, and the edges `arch` judges, already resolved to repo paths.
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
 * One dependency `arch` judges, from a file of the pack to another file, a package, or the
 * package manifest. Both ends of a `file` edge are mapped to modules by path, so a node may be
 * any file: a TypeScript source, or a crate's `Cargo.toml`. Test edges (a dev-dependency, a
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

/** The files one tool processes, as the tool itself reports them; coverage holds each. */
export interface ToolCoverage {
  /** `tsc`, `biome`, `rustc`: named in coverage's messages and in `prerequisites/*`. */
  readonly tool: string;
  /** How the tool fared; the files are undefined unless it is `ok`. */
  readonly integration: Integration;
  readonly files: ReadonlySet<string> | undefined;
  /**
   * When the tool couldn't run and the repo set it optional: whether its config covers a file,
   * read without the tool. Undefined: no approximation, so coverage can't judge without it.
   */
  readonly approximate?: ((file: string) => boolean) | undefined;
  /** Why a file it misses is missed, and how to fix it, completing "<file> is not <...>". */
  readonly uncovered: string;
}

/** What a pack's loader found: one entry per listed pack in `Snapshot.packs`. */
export interface PackLoad {
  readonly coverage: ReadonlyArray<ToolCoverage>;
  readonly edges: ReadonlyArray<Edge>;
  readonly hostUses: ReadonlyArray<HostUse>;
  /** Files the pack's toolchain says don't parse: `rules/syntax` at each. */
  readonly syntaxErrors: ReadonlyArray<{ readonly file: string; readonly message: string }>;
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
  readonly rules: ReadonlyArray<PackRule>;
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
