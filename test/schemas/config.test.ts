import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { decodeStrict } from "../../src/helpers/decodeStrict.ts";
import { resolveConfig, ShapeConfig } from "../../src/schemas/config.ts";

const decodes = (input: unknown): boolean =>
  Exit.isSuccess(Effect.runSyncExit(decodeStrict(ShapeConfig)(input)));

describe("tracks.sharedPaths", () => {
  test("repo-relative paths inside the repo are accepted", () => {
    expect(
      decodes({ tracks: { sharedPaths: ["cases", "data/large", ".cache", "a/.b/c..d"] } }),
    ).toBe(true);
  });

  test("only normal paths: no absolute, `..`, `.`, empty segments or trailing slash", () => {
    for (const bad of [
      "/abs",
      "../outside",
      "data/../../x",
      "..",
      "cases/",
      ".",
      "./x",
      "data//large",
      "data/./x",
      "",
    ])
      expect(decodes({ tracks: { sharedPaths: [bad] } })).toBe(false);
  });

  test("defaults to none", () => {
    expect(resolveConfig({}).tracks.sharedPaths).toEqual([]);
  });
});

describe("review of #59: files config", () => {
  const SHA = "a".repeat(64);
  test("a vendored path is repo-relative and normal, as sharedPaths are", () => {
    const record = (path: string) => ({
      files: { vendored: [{ path, package: "x", sha256: SHA }] },
    });
    expect(decodes(record("vendor/x-1.0.0.tgz"))).toBe(true);
    for (const bad of ["./vendor/x.tgz", "../x.tgz", "/abs/x.tgz", "vendor//x.tgz"])
      expect(decodes(record(bad))).toBe(false);
  });

  test("maxBytes is a positive integer", () => {
    expect(decodes({ files: { maxBytes: 200_000 } })).toBe(true);
    for (const bad of [0, -5, 1.5]) expect(decodes({ files: { maxBytes: bad } })).toBe(false);
  });
});

test("a path that isn't plain says how to write it, not the regex", async () => {
  const { Effect: E, Exit: X, Cause } = await import("effect");
  const exit = E.runSyncExit(
    decodeStrict(ShapeConfig)({
      files: { vendored: [{ path: "./vendor/x.tgz", package: "x", sha256: "a".repeat(64) }] },
    }),
  );
  expect(X.isFailure(exit)).toBe(true);
  expect(X.isFailure(exit) ? Cause.pretty(exit.cause) : "").toContain("not `./vendor/x.tgz`");
});

describe("arch.allowedPackages", () => {
  const allowed = (allowedPackages?: ReadonlyArray<string>) =>
    resolveConfig({
      arch: { modules: {}, ...(allowedPackages ? { allowedPackages } : {}) },
    }).arch?.allowedPackages;

  test("unset, only effect is allowed", () => {
    expect(allowed()).toEqual(["effect"]);
  });

  test("set, the list adds to effect instead of replacing it", () => {
    expect(allowed(["zod", "pg"])).toEqual(["effect", "zod", "pg"]);
  });

  test("listing effect again doesn't repeat it", () => {
    expect(allowed(["effect", "pg"])).toEqual(["effect", "pg"]);
  });
});
