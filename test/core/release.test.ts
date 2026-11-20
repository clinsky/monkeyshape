import { describe, expect, test } from "bun:test";
import {
  BINARY_TARGETS,
  binaryAsset,
  binaryEntry,
  lockedPackage,
  OXC_LOADER,
  oxcForBinary,
  packDestination,
  packVersion,
  publishSteps,
  sha256Sums,
  tagMessage,
  tarballDifferences,
  untaggedWarning,
} from "../../src/core/release.ts";
import { PLATFORMS } from "../../src/core/tools.ts";

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

describe("untaggedWarning", () => {
  test("without the tag, says the pack sorts before the version and how to fetch the tag", () => {
    const untagged = { ...source, tagged: false, atTag: false };
    expect(untaggedWarning(untagged)).toContain("0.3.0-dev.abc1234, which sorts before 0.3.0");
    expect(untaggedWarning(untagged)).toContain("git fetch --tags");
    expect(untaggedWarning(source)).toBeUndefined();
    expect(untaggedWarning({ ...source, atTag: false })).toBeUndefined();
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

describe("the compiled binaries", () => {
  test("one per supported platform: Linux x64 and arm64, macOS arm64", () => {
    expect(BINARY_TARGETS.map(binaryAsset)).toEqual([
      "mshape-linux-x64",
      "mshape-linux-arm64",
      "mshape-darwin-arm64",
    ]);
  });

  test("SHA256SUMS is what `sha256sum --check` reads, sorted by file", () => {
    const sums = sha256Sums(
      new Map([
        ["mshape-linux-x64", "b".repeat(64)],
        ["mshape-darwin-arm64", "a".repeat(64)],
      ]),
    );
    expect(sums).toBe(
      `${"a".repeat(64)}  mshape-darwin-arm64\n${"b".repeat(64)}  mshape-linux-x64\n`,
    );
  });

  test("a binding's version and integrity come from bun.lock, installed or not", () => {
    const lock = [
      `    "@oxc-parser/binding-darwin-arm64": ["@oxc-parser/binding-darwin-arm64@0.156.0", "", { "os": "darwin", "cpu": "arm64" }, "sha512-abc+/="],`,
      `    "@oxc-parser/binding-darwin-arm64-extra": ["@oxc-parser/binding-darwin-arm64-extra@9.9.9", "", {}, "sha512-zzz"],`,
    ].join("\n");
    expect(lockedPackage(lock, "@oxc-parser/binding-darwin-arm64")).toEqual({
      version: "0.156.0",
      integrity: "sha512-abc+/=",
    });
    expect(lockedPackage(lock, "@oxc-parser/binding-linux-x64-gnu")).toBeUndefined();
  });

  test("the entry embeds each file by path and hands them to start", () => {
    const entry = binaryEntry(
      [{ path: "template/AGENTS.md", source: "/r/template/AGENTS.md" }],
      "/r/src/cli/binary.ts",
      "1.0.0",
      "d1",
    );
    expect(entry).toContain(`import file0 from "/r/template/AGENTS.md" with { type: "file" };`);
    expect(entry).toContain(`  "template/AGENTS.md": file0,`);
    expect(entry).toContain(`await start(files, "1.0.0", "d1");`);
  });

  test("oxc's files lose createRequire, and its loader loads the embedded binding", () => {
    const lazy = `function f() {\n  const require = createRequire(import.meta.url);\n  require("./x.js");\n}`;
    expect(oxcForBinary("/n/oxc-parser/src-js/visit/index.js", lazy, "/b.node")).toBe(
      `function f() {\n  \n  require("./x.js");\n}`,
    );
    const bindings = [
      "const require = createRequire(import.meta.url)",
      "function requireNative() { return pick(require('./webcontainer-fallback.cjs')) }",
      "nativeBinding = requireNative()",
      `${OXC_LOADER}\n  throw new Error("none")\n}`,
      "const { parseSync } = nativeBinding",
      "export { parseSync }",
      "",
    ].join("\n");
    expect(oxcForBinary("/n/oxc-parser/src-js/bindings.js", bindings, "/b.node")).toBe(
      [
        `const nativeBinding = require("/b.node");`,
        `const __napiLoadedBindingTarget = "native";`,
        "const { parseSync } = nativeBinding",
        "export { parseSync }",
        "",
      ].join("\n"),
    );
  });

  test("a bindings.js without the loader it replaces is refused, not bundled as is", () => {
    expect(oxcForBinary("/n/oxc-parser/src-js/bindings.js", "load()", "/b.node")).toBeUndefined();
  });
});

test("the tag records the tarball's digest and SHA256SUMS', the pin's sums", () => {
  expect(
    tagMessage("monkeyshape", "1.0.0", [
      ["monkeyshape-1.0.0.tgz", "a".repeat(64)],
      ["SHA256SUMS", "b".repeat(64)],
    ]),
  ).toBe(
    `monkeyshape 1.0.0\n\nsha256 ${"a".repeat(64)}  monkeyshape-1.0.0.tgz\nsha256 ${"b".repeat(64)}  SHA256SUMS\n`,
  );
});

test("pack writes into .release/, which git ignores, unless given a directory", () => {
  expect(packDestination("/r", "/r", undefined)).toBe("/r/.release");
  expect(packDestination("/r", "/r", "/out")).toBe("/out");
  // Relative to the caller: the compile runs in another worktree (lql).
  expect(packDestination("/r/sub", "/r", "../out")).toBe("/r/out");
  expect(packDestination("/r", "/r", "out")).toBe("/r/out");
  expect(packDestination("/r", "/r", "./a/../b/")).toBe("/r/b");
  expect(packDestination("/r", "/r", "/abs/./x")).toBe("/abs/x");
});

test("the publish steps work on gh 2.4: no --verify-tag, and the tag checked on the remote first", () => {
  const steps = publishSteps("v1.2.0", "1.2.0", "/x/pkg.tgz", ["/x/a", "/x/SHA256SUMS"], false);
  expect(steps).toEqual([
    "  git push origin v1.2.0",
    "  bun publish /x/pkg.tgz",
    "  git ls-remote --exit-code --tags origin refs/tags/v1.2.0 && gh release create v1.2.0 /x/a /x/SHA256SUMS",
    "  bun run release verify 1.2.0",
  ]);
  expect(steps.join("\n")).not.toContain("--verify-tag");
  expect(publishSteps("v1.2.0", "1.2.0", "/x/pkg.tgz", ["/x/a"], true)).toEqual([
    "  git push origin v1.2.0",
    "  git ls-remote --exit-code --tags origin refs/tags/v1.2.0 && gh release create v1.2.0 /x/a",
  ]);
});

test("the release builds a binary for every platform mshape supports, and only those", () => {
  expect(BINARY_TARGETS.map((target) => target.platform)).toEqual([...PLATFORMS]);
});
