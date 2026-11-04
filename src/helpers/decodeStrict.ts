/**
 * Decoding that refuses what it doesn't understand. Effect's default strips unknown keys,
 * so a misspelt or stale field disappears silently; the `decode-strict` rule points here.
 */
import { Schema } from "effect";

export const decodeStrict = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(schema, { errors: "all", onExcessProperty: "error" });

/** The same, for synchronous code: returns the value or throws the parse error. */
export const decodeStrictSync = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.decodeUnknownSync(schema, { errors: "all", onExcessProperty: "error" });
