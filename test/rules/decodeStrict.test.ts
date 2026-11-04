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

const lines = (...source: ReadonlyArray<string>) =>
  ruleLines(decodeStrict, ['import { Schema } from "effect";', ...source].join("\n"));

describe("decode-strict: strict options however they are written", () => {
  test("passes: options in a same-file const, `as const`, an alias of it, or spread into an object", () => {
    expect(
      lines(
        'const strict = { errors: "all", onExcessProperty: "error" } as const;',
        "const again = strict;",
        "export const a = Schema.decodeUnknownEffect(User, strict);",
        "export const b = Schema.decodeUnknownSync(User, again);",
        "export const c = Schema.decodeUnknownSync(User, { ...strict, errors: 'first' });",
      ),
    ).toEqual([]);
  });

  test("passes: options given to the decoder it returns", () => {
    expect(lines('Schema.decodeUnknownSync(User)(input, { onExcessProperty: "error" });')).toEqual(
      [],
    );
  });

  test("fails: a const without onExcessProperty, or one shadowed by a parameter", () => {
    expect(
      lines(
        'const loose = { errors: "all" } as const;',
        'const strict = { onExcessProperty: "error" } as const;',
        "Schema.decodeUnknownSync(User, loose);",
        "export const f = (strict: object) => Schema.decodeUnknownSync(User, strict);",
        'export const g = () => { const strict = { onExcessProperty: "ignore" }; return Schema.decodeSync(User, strict); };',
        "Schema.decodeUnknownSync(User, imported);",
      ),
    ).toEqual([4, 5, 6, 7]);
  });

  test("fails: options to the returned decoder that aren't strict", () => {
    expect(lines('Schema.decodeUnknownSync(User)(input, { errors: "all" });')).toEqual([2]);
  });
});

describe("decode-strict: schemas with no properties", () => {
  test("passes: branded strings, literals, and arrays or unions of them, inline or in a const", () => {
    expect(
      lines(
        'const Sha = Schema.String.pipe(Schema.brand("Sha"));',
        'const Id = Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand("Id"));',
        "const Ids = Schema.Array(Id);",
        'const Kind = Schema.Union([Schema.Literal("a"), Schema.Number]);',
        "Schema.decodeSync(Sha)(x);",
        "Schema.decodeUnknownSync(Ids)(x);",
        "Schema.decodeUnknownEffect(Kind)(x);",
        'Schema.decodeSync(Schema.String.pipe(Schema.brand("Inline")))(x);',
      ),
    ).toEqual([]);
  });

  test("fails: a struct, an array of structs, a union holding one, or a schema it can't see", () => {
    expect(
      lines(
        "const User = Schema.Struct({ name: Schema.String });",
        "Schema.decodeSync(User)(x);",
        "Schema.decodeSync(Schema.Array(User))(x);",
        "Schema.decodeSync(Schema.Union([Schema.String, User]))(x);",
        "Schema.decodeSync(Imported)(x);",
        "Schema.decodeSync(Schema.String.pipe(Schema.extend(User)))(x);",
      ),
    ).toEqual([3, 4, 5, 6, 7]);
  });

  test("fails: a local named like a no-property schema that isn't one", () => {
    expect(
      lines(
        'const Sha = Schema.String.pipe(Schema.brand("Sha"));',
        "export const f = (Sha: Schema.Top) => Schema.decodeSync(Sha)(x);",
      ),
    ).toEqual([3]);
  });
});

describe("decode-strict: aliases", () => {
  test("fails: a decoder or Schema reached through a const alias", () => {
    expect(
      lines(
        "const S = Schema;",
        "const decode = Schema.decodeUnknownSync;",
        "S.decodeUnknownSync(User)(x);",
        "decode(User)(x);",
      ),
    ).toEqual([4, 5]);
  });

  test("passes: a local named Schema that isn't effect's", () => {
    expect(
      ruleLines(
        decodeStrict,
        "export const f = (Schema: { decodeSync: (s: unknown) => unknown }) => Schema.decodeSync(User);",
      ),
    ).toEqual([]);
  });
});

describe("decode-strict: #58 review", () => {
  test("fails: the call's options override the decoder's, so a later ignore wins", () => {
    expect(
      lines(
        'Schema.decodeUnknownSync(User, { onExcessProperty: "error" })(x, { onExcessProperty: "ignore" });',
      ),
    ).toEqual([2]);
  });

  test("passes: the call's options say error, or say nothing of it", () => {
    expect(
      lines(
        'Schema.decodeUnknownSync(User, { errors: "all" })(x, { onExcessProperty: "error" });',
        'Schema.decodeUnknownSync(User, { onExcessProperty: "error" })(x, { errors: "all" });',
        'Schema.decodeUnknownSync(User, { onExcessProperty: "error" })(x, undefined);',
      ),
    ).toEqual([]);
  });

  test("fails: a spread the file can't see, after the key, may undo it", () => {
    expect(
      lines(
        'export const f = (o: object) => Schema.decodeUnknownSync(User, { onExcessProperty: "error", ...o });',
        "export const g = (o: object) => Schema.decodeUnknownSync(User)(x, { ...o });",
      ),
    ).toEqual([2, 3]);
  });

  test("passes: a spread the file can't see, before the key", () => {
    expect(
      lines(
        'export const f = (o: object) => Schema.decodeUnknownSync(User, { ...o, onExcessProperty: "error" });',
      ),
    ).toEqual([]);
  });
});
