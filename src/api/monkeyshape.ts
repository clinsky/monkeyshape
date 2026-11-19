/**
 * The public surface: what an adopter imports from `monkeyshape`. `defineConfig`, `defineRule`
 * and `walk` stay only so `mshape config migrate` can import a `shape.config.ts` from before
 * 0.6.0 and the rule modules it lists; mshape reads `shape.toml` and runs `shape-rules/`.
 */
import type { LocalRule } from "../core/rules/local.ts";
import type { ShapeConfig as DecodedConfig } from "../schemas/config.ts";

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
export { decodeStrict, decodeStrictSync } from "../helpers/decodeStrict.ts";
export type { Allowance, ModuleRule } from "../schemas/config.ts";

/**
 * `shape.config.ts` as its author writes it. `localRules` holds rules, so tsc rejects a path
 * or a module namespace at edit time; the decoder takes anything there, so the rules check
 * can still say what's wrong with a config that skipped tsc.
 */
export type ShapeConfig = Omit<DecodedConfig, "localRules"> & {
  readonly localRules?: ReadonlyArray<LocalRule>;
};

/** Identity, as an old `shape.config.ts` wrote it: `export default defineConfig({ ... })`. */
export const defineConfig = (config: ShapeConfig): ShapeConfig => config;
