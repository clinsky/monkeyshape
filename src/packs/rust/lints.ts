/**
 * The curated workspace lints, and how they reach a repo. Cargo has no `extends`, and a
 * member's `[lints] workspace = true` can't be combined with lints of its own, so `mshape
 * sync` owns the `[workspace.lints.rust]` and `[workspace.lints.clippy]` tables in the root
 * `Cargo.toml`: their content is these lints with the repo's `[rust.lints]` overrides from
 * `shape.toml` laid over them, and the `sync` check compares the tables by value. Each member
 * opts in with `[lints] workspace = true`, which `memberFindings` holds it to.
 *
 * Each lint is allow-by-default and catches a class of agent-written bug, as the TypeScript
 * pack's rules do; clippy's default set already runs, and the gate's `-D warnings` makes
 * `warn` fail it. Every lint here passes on a fresh `cargo new`: one turned on lands in every
 * Rust repo on its next `mshape sync`.
 */

export type Level = "allow" | "warn" | "deny" | "forbid";

export type LintSetting = Level | { readonly level: Level; readonly priority: number };

/** The tools whose lints a workspace configures, as Cargo names its tables. */
export type LintTool = "rust" | "clippy";

export type Lints = Readonly<Record<LintTool, Readonly<Record<string, LintSetting>>>>;

export const CURATED: Lints = {
  rust: {
    // Memory safety is the one guarantee the gate can't check past an `unsafe` block.
    unsafe_code: "deny",
    // `let _ = guard;` drops at once: a lock or a span that was meant to live.
    let_underscore_drop: "warn",
    // Elided lifetimes in paths and the 2015 idioms hide what a type borrows.
    rust_2018_idioms: { level: "warn", priority: -1 },
  },
  clippy: {
    // Debugging output and stubs left behind by a session.
    dbg_macro: "warn",
    todo: "warn",
    unimplemented: "warn",
    // Rust's escape hatch, held as `shape-ignore` is: `#[expect]`, which fails once it
    // suppresses nothing, and always with a reason a later agent can weigh.
    allow_attributes: "warn",
    allow_attributes_without_reason: "warn",
    undocumented_unsafe_blocks: "warn",
  },
};

const LINT_TOOLS: ReadonlyArray<LintTool> = ["rust", "clippy"];

/** The tables `sync` owns, as dotted paths. */
export const LINT_TABLES: ReadonlyArray<string> = LINT_TOOLS.map(
  (tool) => `workspace.lints.${tool}`,
);

/** The curated lints with a repo's overrides laid over them, lint by lint. */
export const effectiveLints = (overrides: Partial<Lints> | undefined): Lints => ({
  rust: { ...CURATED.rust, ...overrides?.rust },
  clippy: { ...CURATED.clippy, ...overrides?.clippy },
});

const renderSetting = (setting: LintSetting): string =>
  typeof setting === "string"
    ? `"${setting}"`
    : `{ level = "${setting.level}", priority = ${setting.priority} }`;

/** The owned tables as TOML, lints sorted by name, as `sync` writes them. */
export const renderLints = (lints: Lints): string =>
  LINT_TOOLS.map((tool) =>
    [
      `[workspace.lints.${tool}]`,
      ...Object.keys(lints[tool])
        .sort()
        .map((name) => `${name} = ${renderSetting(lints[tool][name] ?? "allow")}`),
    ].join("\n"),
  ).join("\n\n");

export interface MemberFinding {
  readonly kind: "member-lints";
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** The `[lints]` header's line, or undefined. */
const lintsHeaderLine = (text: string): number | undefined => {
  const index = text.split("\n").findIndex((line) => /^\s*\[\s*lints\s*\]/.test(line));
  return index === -1 ? undefined : index + 1;
};

const optsIn = (parsed: unknown): boolean => {
  if (typeof parsed !== "object" || parsed === null || !("lints" in parsed)) return false;
  const lints = parsed.lints;
  return (
    typeof lints === "object" && lints !== null && "workspace" in lints && lints.workspace === true
  );
};

/**
 * A finding for each member manifest that doesn't take the workspace's lints. `parse` is
 * TOML's parser (Bun's, in the pack), returning undefined for text that doesn't parse: that
 * manifest is cargo's to report, not this check's.
 */
export const memberFindings = (
  manifests: ReadonlyArray<string>,
  texts: ReadonlyMap<string, string>,
  parse: (text: string) => unknown,
): ReadonlyArray<MemberFinding> =>
  manifests.flatMap((file) => {
    const text = texts.get(file);
    if (text === undefined) return [];
    const parsed = parse(text);
    if (parsed === undefined || optsIn(parsed)) return [];
    const header = lintsHeaderLine(text);
    return [
      {
        kind: "member-lints" as const,
        file,
        line: header ?? 1,
        message:
          header === undefined
            ? "doesn't take the workspace's curated lints, so clippy holds this crate to less than the rest. Add `[lints]` with `workspace = true` to this Cargo.toml; to change a lint for the whole workspace, set it under `[rust.lints.clippy]` or `[rust.lints.rust]` in shape.toml."
            : 'sets lints of its own instead of `workspace = true`, so clippy holds this crate to less than the rest, and Cargo can\'t combine the two. Make `[lints]` hold only `workspace = true`; to change a lint, set it under `[rust.lints.clippy]` or `[rust.lints.rust]` in shape.toml, or `#[expect(clippy::<lint>, reason = "...")]` at the code.',
      },
    ];
  });
