import { describe, expect, test } from "bun:test";
import { decodeStrict } from "../../src/core/rules/decodeStrict.ts";
import { ruleLines } from "../support.ts";

describe("decode-strict", () => {
  test("fails: default decoders, however Schema is imported", () => {
    expect(
      ruleLines(
        decodeStrict,
        [
          'import { Schema } from "effect";',
          "Schema.decodeUnknownEffect(User)(input);",
          'Schema.decodeUnknownSync(User, { errors: "all" })(input);',
        ].join("\n"),
      ),
    ).toEqual([2, 3]);
    expect(
      ruleLines(decodeStrict, 'import * as S from "effect/Schema";\nS.decodeUnknownExit(User)(x);'),
    ).toEqual([2]);
    expect(
      ruleLines(
        decodeStrict,
        'import { decodeUnknownSync } from "effect/Schema";\ndecodeUnknownSync(User)(x);',
      ),
    ).toEqual([2]);
  });

  test("passes: strict options inline, decodeStrict, and transformation builders", () => {
    expect(
      ruleLines(
        decodeStrict,
        [
          'import { Schema } from "effect";',
          'Schema.decodeUnknownEffect(User, { errors: "all", onExcessProperty: "error" })(input);',
          "decodeStrict(User)(input);",
          "Schema.decodeTo(Other);",
          "other.decodeUnknownSync(x);",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});
