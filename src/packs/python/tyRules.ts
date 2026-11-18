/**
 * The curated ty rules, and how they reach a repo. ty has no `extends` (its config rejects the
 * key), so `mshape sync` owns the `[tool.ty.rules]` table in the root `pyproject.toml`: these
 * levels with the repo's `[python.ty-rules]` overrides from `shape.toml` laid over them, rule by
 * rule, and the `sync` check compares the table by value. Cargo's lints reach a Rust repo the
 * same way.
 *
 * ty's own defaults stand for every rule not named here. Each one named is off or a warning by
 * default and catches a class of agent-written bug; the gate's `ty check` fails on `error`
 * only. Every rule here passes on a fresh `uv init`.
 */

export type TyLevel = "ignore" | "warn" | "error";

export const CURATED_TY: Readonly<Record<string, TyLevel>> = {
  // A name or attribute bound on only some paths: an AttributeError or NameError at runtime.
  "possibly-missing-attribute": "error",
  "possibly-missing-import": "error",
  "possibly-unresolved-reference": "error",
  "possibly-missing-implicit-call": "error",
  "possibly-missing-submodule": "error",
  "unresolved-global": "error",
  // A coroutine never awaited: the work silently doesn't happen.
  "unused-awaitable": "error",
  // A callable or a generator tested for truth: always true, so the call was forgotten.
  "truthiness-test-of-callable": "error",
  "truthiness-test-of-iterable": "error",
  "division-by-zero": "error",
  // `list` with no type argument is `list[Unknown]`, which ty then checks nothing about.
  "missing-type-argument": "error",
  // Deprecated APIs, and casts that do nothing.
  deprecated: "error",
  "redundant-cast": "error",
  // Suppressions held as `shape-ignore` is: a code, and gone once it suppresses nothing.
  "blanket-ignore-comment": "error",
  "unused-ignore-comment": "error",
  "unused-type-ignore-comment": "error",
  "invalid-ignore-comment": "error",
  "ignore-comment-unknown-rule": "error",
  "undefined-reveal": "error",
};

/** The table `sync` owns, as a dotted path. */
export const TY_TABLE = "tool.ty.rules";

/** The curated levels with a repo's overrides laid over them, rule by rule. */
export const effectiveTyRules = (
  overrides: Readonly<Record<string, TyLevel>> | undefined,
): Readonly<Record<string, TyLevel>> => ({ ...CURATED_TY, ...overrides });

/** The table as `sync` writes it: its header, then one rule per line in name order. */
export const renderTyRules = (rules: Readonly<Record<string, TyLevel>>): string =>
  [
    `[${TY_TABLE}]`,
    ...Object.keys(rules)
      .sort()
      .map((rule) => `${rule} = "${rules[rule]}"`),
    "",
  ].join("\n");
