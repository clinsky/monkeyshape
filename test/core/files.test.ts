import { describe, expect, test } from "bun:test";
import { report } from "../../src/core/check.ts";
import { checkFiles } from "../../src/core/files.ts";
import { config, repo } from "../support.ts";

const rules = (...args: Parameters<typeof repo>) =>
  checkFiles(config(), repo(...args)).map((v) => `${v.rule} ${v.file}`);

describe("files", () => {
  test("the cap is 1 MiB by default, and the message says how far past it a file is", () => {
    const [found] = checkFiles(
      config(),
      repo(
        { "a.bin": "", "b.bin": "" },
        { sizes: { "a.bin": 30 * 1024 * 1024, "b.bin": 1024 * 1024 } },
      ),
    );
    expect(found?.file).toBe("a.bin");
    expect(found?.message).toContain("is 30.0 MiB, past the 1.0 MiB cap");
  });

  test("environment files, by name in any directory; templates and lookalikes pass", () => {
    const names = [
      ".env",
      ".env.local",
      "app/.env.production",
      ".env.example",
      "app/.env.template",
      ".envrc",
      "env",
      "src/.env.ts.md",
    ];
    expect(rules(Object.fromEntries(names.map((name) => [name, ""])))).toEqual([
      "files/env .env",
      "files/env .env.local",
      "files/env app/.env.production",
      "files/env src/.env.ts.md",
    ]);
  });

  test("a symlink is held to nothing: its target is checked where it lives", () => {
    expect(
      rules({ ".env": "" }, { modes: { ".env": "symlink" }, sizes: { ".env": 99 * 1024 * 1024 } }),
    ).toEqual([]);
  });

  test("a recorded artifact that isn't an npm tarball says why its name can't be read", () => {
    const shape = config({
      files: { vendored: [{ path: "vendor/x.tgz", package: "x", sha256: "c".repeat(64) }] },
    });
    const [found] = checkFiles(
      shape,
      repo(
        { "vendor/x.tgz": "" },
        {
          vendored: {
            "vendor/x.tgz": {
              sha256: "c".repeat(64),
              package: { unreadable: "it has no package/package.json" },
            },
          },
        },
      ),
    );
    expect(found?.rule).toBe("files/vendored-package");
    expect(found?.message).toContain("it has no package/package.json");
  });

  test("a wrong digest and a wrong package are two findings, not one", () => {
    const shape = config({
      files: { vendored: [{ path: "vendor/x.tgz", package: "x", sha256: "c".repeat(64) }] },
    });
    const snapshot = repo(
      { "vendor/x.tgz": "" },
      { vendored: { "vendor/x.tgz": { sha256: "d".repeat(64), package: { name: "y" } } } },
    );
    expect(checkFiles(shape, snapshot).map((v) => v.rule)).toEqual([
      "files/vendored-digest",
      "files/vendored-package",
    ]);
  });

  test("its report says what it held and against what cap", () => {
    const got = report("files", config(), repo({ "a.md": "", ".gitignore": "", "b.json": "" }));
    expect(got.outcome).toEqual({ state: "passed", examined: "2 files against the 1.0 MiB cap" });
  });
});
