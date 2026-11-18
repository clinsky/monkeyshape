/**
 * One rule id's must-fail and must-pass case, as test/core/ruleCases.test.ts runs them. A
 * pack keeps its own kinds' cases in its test directory (test/packs/<id>/ruleCases.ts), and
 * the shared file spreads them in, so it grows by a line per pack, not by its cases.
 */
import type { ShapeConfig } from "../../src/schemas/config.ts";
import type { repo } from "../support.ts";

export interface Case {
  readonly files?: Readonly<Record<string, string>>;
  readonly config?: ShapeConfig;
  readonly options?: Parameters<typeof repo>[1];
}

export interface Cases {
  readonly fail: Case;
  readonly pass: Case;
}
