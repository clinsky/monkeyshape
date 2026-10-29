/**
 * Decoding that refuses what it doesn't understand. Effect's default strips unknown keys,
 * so a misspelt or stale field disappears silently; the `decode-strict` rule points here.
 */
import { Schema } from "effect";

export const decodeStrict = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(schema, { errors: "all", onExcessProperty: "error" });
