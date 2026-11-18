import { describe, expect, test } from "bun:test";
import { cacheRoot, unpackedDir } from "../../src/core/launch.ts";

describe("cacheRoot", () => {
  test("XDG_CACHE_HOME first, then HOME's .cache, then the fallback", () => {
    expect(cacheRoot({ XDG_CACHE_HOME: "/x/", HOME: "/h" }, "/tmp")).toBe("/x/monkeyshape");
    expect(cacheRoot({ XDG_CACHE_HOME: "", HOME: "/h" }, "/tmp")).toBe("/h/.cache/monkeyshape");
    expect(cacheRoot({}, "/tmp")).toBe("/tmp/monkeyshape");
  });

  test("each build of a version unpacks into its own directory", () => {
    expect(unpackedDir("/c", "1.0.0-dev.abc.dirty", "d1")).toBe(
      "/c/1.0.0-dev.abc.dirty/package-d1",
    );
  });
});
