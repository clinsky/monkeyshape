import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { decodeStrict } from "../../src/helpers/decodeStrict.ts";
import { resolveConfig, ShapeConfig } from "../../src/schemas/config.ts";

const decodes = (input: unknown): boolean =>
  Exit.isSuccess(Effect.runSyncExit(decodeStrict(ShapeConfig)(input)));

describe("tracks.sharedPaths", () => {
  test("repo-relative paths inside the repo are accepted", () => {
    expect(decodes({ tracks: { sharedPaths: ["cases", "data/large", ".cache"] } })).toBe(true);
  });

  test("absolute paths, `..` segments and trailing slashes are refused", () => {
    for (const bad of ["/abs", "../outside", "data/../../x", "..", "cases/"])
      expect(decodes({ tracks: { sharedPaths: [bad] } })).toBe(false);
  });

  test("defaults to none", () => {
    expect(resolveConfig({}).tracks.sharedPaths).toEqual([]);
  });
});
