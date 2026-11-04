/** The public surface: what an adopter imports from `monkeyshape`. */
import type { ShapeConfig } from "../schemas/config.ts";

export type {
  Expression,
  Finding,
  LocalRule,
  Node,
  Program,
  SourceFile,
  Visitors,
} from "../core/rules/local.ts";
export { defineRule, walk } from "../core/rules/local.ts";
export { decodeStrict } from "../helpers/decodeStrict.ts";
export type { Allowance, ModuleRule, ShapeConfig } from "../schemas/config.ts";

/** Identity, for type-checking `shape.config.ts`: `export default defineConfig({ ... })`. */
export const defineConfig = (config: ShapeConfig): ShapeConfig => config;
