import { describe, expect, test } from "bun:test";
import { Effect, Exit, Schema } from "effect";
import { decodeStrict, decodeStrictSync } from "../../src/api/monkeyshape.ts";

const User = Schema.Struct({ name: Schema.String });

describe("decodeStrict helpers", () => {
  test("decodeStrict refuses an unknown key, as an Effect", () => {
    expect(Exit.isSuccess(Effect.runSyncExit(decodeStrict(User)({ name: "a" })))).toBe(true);
    expect(Exit.isFailure(Effect.runSyncExit(decodeStrict(User)({ name: "a", nmae: "b" })))).toBe(
      true,
    );
  });

  test("decodeStrictSync refuses an unknown key, by throwing, and reports every issue", () => {
    expect(decodeStrictSync(User)({ name: "a" })).toEqual({ name: "a" });
    expect(() => decodeStrictSync(User)({ name: "a", nmae: "b" })).toThrow();
    let message = "";
    try {
      decodeStrictSync(User)({ nmae: "b", extra: 1 });
    } catch (error) {
      message = String(error);
    }
    // errors: "all": the missing key and both unknown keys, not only the first.
    expect(message).toContain("nmae");
    expect(message).toContain("extra");
  });
});
