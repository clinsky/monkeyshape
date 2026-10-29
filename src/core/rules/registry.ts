/** Every custom rule. Adding one: a file in this directory, an entry here, fixtures in test/rules. */
import { decodeStrict } from "./decodeStrict.ts";
import { effectRunAtEdge } from "./effectRunAtEdge.ts";
import type { Rule } from "./engine.ts";
import { noErrorSpread } from "./noErrorSpread.ts";
import { noNondeterminism } from "./noNondeterminism.ts";
import { noThrow } from "./noThrow.ts";

export const RULES: ReadonlyArray<Rule> = [
  decodeStrict,
  noNondeterminism,
  noThrow,
  effectRunAtEdge,
  noErrorSpread,
];
