/** The first test: bun test, TypeScript and effect run together. Replace it with your own. */
import { expect, test } from "bun:test";
import { Effect } from "effect";

test("the toolchain runs an effect", () => {
  expect(Effect.runSync(Effect.succeed(1 + 1))).toBe(2);
});
