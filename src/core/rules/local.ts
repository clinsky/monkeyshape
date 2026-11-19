/**
 * What a `localRules` module imported from `monkeyshape`, kept only so `mshape config migrate`
 * can import an old `shape.config.ts` and read its rules' ids. mshape runs none of them: a
 * repo's own rules are `shape-rules/<id>.yml`, run through ast-grep (docs/local-rules.md).
 */
import type { Expression, Node, Program, VisitorObject } from "oxc-parser";
import { Visitor } from "oxc-parser";
import type { Finding } from "./rule.ts";

export type { Expression, Finding, Node, Program };

/** Handlers by node type, e.g. `{ CallExpression: (node) => ... }`, each given a typed node. */
export type Visitors = VisitorObject;

/** What a local rule is given: one file in the rules' scope, parsed. */
export interface SourceFile {
  /** Repo-relative. */
  readonly path: string;
  readonly text: string;
  readonly program: Program;
}

/** What a local rule module exports: what a registry rule has, and nothing more. */
export interface LocalRule {
  /** Lowercase words joined by hyphens; reported, configured and ignored as `local/<id>`. */
  readonly id: string;
  /** The class of bug the rule removes, for `mshape rules`. */
  readonly bugClass: string;
  /** Why, and what to do instead. Shown with every violation. */
  readonly message: string;
  /**
   * Each violation in the file: its offset (UTF-16, as `node.start`), or `{ offset, message }`
   * to say more than the rule's message for this one.
   */
  readonly check: (file: SourceFile) => Iterable<number | Finding>;
  /**
   * Sources the rule is run on at every `mshape check`, so it can't silently stop catching its
   * bug or start firing on valid code. A case is source text, or `{ path, source }` when the
   * rule looks at the path (default path `src/case.ts`).
   */
  readonly cases: {
    /** Each has the bug, and must be reported at least once. At least one. */
    readonly fail: ReadonlyArray<Case>;
    /** Valid code close to the bug, on which nothing may be reported. At least one. */
    readonly pass: ReadonlyArray<Case>;
    /**
     * The exceptions the rule makes on purpose, such as the enforcement point itself: code
     * that looks like the bug and must not be reported. Needed when the rule makes one. The
     * exception may be in `check` or in the config's `rules["local/<id>"].allow`: an allowed
     * case whose path the config allows reports nothing, as in a real run. Must-fail and
     * must-pass cases ignore allowances: they test the rule's own logic.
     */
    readonly allowed?: ReadonlyArray<Case>;
  };
}

export type Case = string | { readonly path: string; readonly source: string };

/** Identity, for type-checking a rule module: `export default defineRule({ ... })`. */
export const defineRule = (rule: LocalRule): LocalRule => rule;

/** Calls each handler on every node of its type, depth first, parents before children. */
export const walk = (program: Program, visitors: Visitors): void => {
  new Visitor(visitors).visit(program);
};
