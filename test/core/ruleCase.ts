/**
 * One rule id's must-fail and must-pass case, as test/core/ruleCases.test.ts runs them. A
 * pack keeps its own kinds' cases in its test directory (test/packs/<id>/ruleCases.ts), and
 * the shared file spreads them in, so it grows by a line per pack, not by its cases.
 */
import type { ShapeRuleRun } from "../../src/core/model.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import type { repo } from "../support.ts";

export interface Case {
  readonly files?: Readonly<Record<string, string>>;
  readonly config?: ShapeConfig;
  readonly options?: Parameters<typeof repo>[1];
  /** The repo's shape-rules/ as ast-grep ran them, where the case needs some. */
  readonly shapeRules?: ReadonlyArray<ShapeRuleRun>;
}

export interface Cases {
  readonly fail: Case;
  readonly pass: Case;
}
