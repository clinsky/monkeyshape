import { describe, expect, test } from "bun:test";
import { packVersion, tarballDifferences } from "../../src/core/release.ts";

const source = { version: "0.3.0", tagged: true, atTag: true, commit: "abc1234", dirty: false };

describe("packVersion", () => {
  test("only the tagged commit, unchanged, carries the released version", () => {
    expect(packVersion(source)).toBe("0.3.0");
    expect(packVersion({ ...source, dirty: true })).toBe("0.3.1-dev.abc1234.dirty");
  });

  test("past a release, a pack is a prerelease of the next version, naming its commit", () => {
    expect(packVersion({ ...source, atTag: false })).toBe("0.3.1-dev.abc1234");
  });

  test("before its tag, a version not yet released is a prerelease of itself", () => {
    expect(packVersion({ ...source, tagged: false, atTag: false })).toBe("0.3.0-dev.abc1234");
  });
});

describe("tarballDifferences", () => {
  const files = (entries: Record<string, string>) => new Map(Object.entries(entries));
  const published = {
    version: "0.3.0",
    files: files({ "package/a.ts": "1", "package/b.ts": "2" }),
  };

  test("none for the same files with the same content", () => {
    expect(tarballDifferences({ ...published }, published)).toEqual([]);
  });

  test("names the version, each file only on one side, and each changed file", () => {
    const packed = { version: "0.3.1", files: files({ "package/a.ts": "x", "package/c.ts": "3" }) };
    expect(tarballDifferences(packed, published)).toEqual([
      "version: packed 0.3.1, published 0.3.0",
      "content differs: package/a.ts",
      "only in the packed tarball: package/c.ts",
      "only in the published tarball: package/b.ts",
    ]);
  });
});
