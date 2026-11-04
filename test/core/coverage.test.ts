import { describe, expect, test } from "bun:test";
import { notices } from "../../src/core/check.ts";
import {
  biomeCovers,
  checkCoverage,
  commandReports,
  tsconfigCovers,
} from "../../src/core/coverage.ts";
import { stripJsonc } from "../../src/core/jsonc.ts";
import { config, repo } from "../support.ts";

const configs = (tsconfig: object, biome: object) => ({
  "tsconfig.json": JSON.stringify(tsconfig),
  "biome.json": JSON.stringify(biome),
});

const rules = (files: Record<string, string>) =>
  checkCoverage(config(), repo(files)).map((v) => `${v.rule} ${v.file}`);

describe("coverage", () => {
  test("every TypeScript file is typechecked and linted", () => {
    const files = {
      ...configs({ include: ["src"] }, { files: { includes: ["src/**"] } }),
      "src/a.ts": "",
    };
    expect(rules(files)).toEqual([]);
  });

  test("an excluded script is reported by both tools", () => {
    const files = {
      ...configs(
        { include: ["src", "scripts"], exclude: ["scripts/old.ts"] },
        { files: { includes: ["src/**"] } },
      ),
      "scripts/old.ts": "",
    };
    expect(rules(files)).toEqual([
      "coverage/typecheck scripts/old.ts",
      "coverage/lint scripts/old.ts",
    ]);
  });

  test("generated and vendored segments are exempt", () => {
    const files = {
      ...configs({ include: ["src"] }, { files: { includes: ["src/**"] } }),
      "vendor/x/y.ts": "",
    };
    expect(rules(files)).toEqual([]);
  });

  test("missing or invalid configs are reported once, not once per file", () => {
    expect(rules({ "tsconfig.json": "{", "src/a.ts": "" })).toEqual([
      "coverage/config tsconfig.json",
      "coverage/config biome.json",
    ]);
  });

  test("the tools' own file lists win over reading their configs", () => {
    const files = {
      ...configs({ include: ["src"] }, { files: { includes: ["src/**"] } }),
      "src/a.ts": "",
      "src/b.ts": "",
    };
    const snapshot = repo(files, { typechecked: ["src/a.ts"], linted: ["src/b.ts"] });
    expect(checkCoverage(config(), snapshot).map((v) => `${v.rule} ${v.file}`)).toEqual([
      "coverage/lint src/a.ts",
      "coverage/typecheck src/b.ts",
    ]);
  });

  test("files: [] includes nothing; only an absent files defaults include to everything", () => {
    expect(tsconfigCovers("tsconfig.json", { files: [] }, "src/a.ts")).toBe(false);
    expect(
      tsconfigCovers("tsconfig.json", { files: [], references: [{ path: "./src" }] }, "src/a.ts"),
    ).toBe(false);
    expect(tsconfigCovers("tsconfig.json", { files: [], include: ["src"] }, "src/a.ts")).toBe(true);
  });

  test("tsconfig semantics: directories, globs, files, nested projects", () => {
    expect(tsconfigCovers("tsconfig.json", { include: ["src"] }, "src/deep/a.ts")).toBe(true);
    expect(tsconfigCovers("tsconfig.json", { include: ["src/**/*"] }, "src/a.ts")).toBe(true);
    expect(tsconfigCovers("tsconfig.json", {}, "anything.ts")).toBe(true);
    expect(tsconfigCovers("tsconfig.json", { files: ["a.ts"] }, "b.ts")).toBe(false);
    expect(tsconfigCovers("ui/tsconfig.json", { include: ["src"] }, "ui/src/a.tsx")).toBe(true);
    expect(tsconfigCovers("ui/tsconfig.json", { include: ["src"] }, "src/a.ts")).toBe(false);
  });

  test("biome includes are ordered: a later pattern overrides an earlier one", () => {
    const biome = { files: { includes: ["**", "!scripts", "scripts/keep.ts"] } };
    expect(biomeCovers(biome, "src/a.ts")).toBe(true);
    expect(biomeCovers(biome, "scripts/old.ts")).toBe(false);
    expect(biomeCovers(biome, "scripts/keep.ts")).toBe(true);
    expect(biomeCovers({}, "x.ts")).toBe(true);
  });

  test("JSONC: comments and trailing commas, but not inside strings", () => {
    const text = '{\n  // c\n  "a": "x // y", /* b */\n  "b": [1, 2,],\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ a: "x // y", b: [1, 2] });
  });
});

describe("executable source and declared commands", () => {
  const TOOLS = configs({}, {});
  const check = (
    files: Record<string, string>,
    shape: Parameters<typeof config>[0] = {},
    options: Parameters<typeof repo>[1] = {},
  ) =>
    checkCoverage(config(shape), repo({ ...TOOLS, ...files }, options)).map(
      (v) => `${v.rule} ${v.file}`,
    );

  test("this repo's shape needs no declaration: bd's hooks, git's files, a symlink, metadata", () => {
    const files = {
      ".beads/hooks/pre-commit": "#!/bin/sh\n",
      ".claude/skills": "../.agents/skills",
      ".gitignore": "",
      "data/.gitkeep": "",
      "bun.lock": "",
      LICENSE: "",
      "template/gitignore": "",
      ".github/workflows/ci.yml": "on: push\n",
    };
    const modes = { ".beads/hooks/pre-commit": "executable", ".claude/skills": "symlink" } as const;
    expect(check(files, {}, { modes })).toEqual([]);
  });

  test("an undeclared Python script and an executable under .github/scripts/ fail", () => {
    const files = { "tools/gen.py": "", ".github/scripts/release": "#!/bin/sh\n" };
    const modes = { ".github/scripts/release": "executable" } as const;
    expect(check(files, {}, { modes })).toEqual([
      "coverage/uncovered tools/gen.py",
      "coverage/uncovered .github/scripts/release",
    ]);
  });

  test("a declared command covers its files; an exemption needs a reason and a match", () => {
    const files = { "native/a.c": "", "native/a.h": "", "tools/gen.py": "" };
    const shape = {
      coverage: {
        commands: [{ files: ["native"], run: ["make", "-C", "native"] }],
        exemptFiles: [
          { path: "tools/*.py", reason: "one-off migration, run once" },
          { path: "old/**", reason: "removed last release" },
        ],
      },
    };
    expect(check(files, shape, { commands: [{ state: "ran", code: 0, output: "" }] })).toEqual([
      "coverage/exempt-unmatched shape.config.ts",
    ]);
  });

  test("generated and vendored segments exempt executable source too", () => {
    expect(check({ "vendor/lib/x.js": "", "dist/cli.js": "" })).toEqual([]);
  });

  test("each command's outcome: passed, failed with its output, unavailable", () => {
    const files = { "a/x.c": "", "b/y.py": "", "c/z.go": "" };
    const shape = {
      coverage: {
        commands: [
          { files: ["a/**"], run: ["cc", "a/x.c"] },
          { files: ["b/**"], run: ["ruff", "check", "b"] },
          { files: ["c/**"], run: ["go", "vet"] },
        ],
      },
    };
    const commands = [
      { state: "ran", code: 0, output: "" },
      { state: "ran", code: 1, output: "b/y.py:1: E999 SyntaxError" },
      { state: "unavailable", reason: "`go` is not on PATH" },
    ] as const;
    const snapshot = repo({ ...TOOLS, ...files }, { commands });
    const found = checkCoverage(config(shape), snapshot);
    expect(found.map((v) => v.rule)).toEqual([
      "coverage/command-failed",
      "coverage/command-unavailable",
    ]);
    expect(found[0]?.message).toContain("`ruff check b` exited 1");
    expect(found[0]?.message).toContain("E999 SyntaxError");
    expect(found[1]?.message).toContain("`go` is not on PATH");
    expect(commandReports(config(shape), snapshot).map((r) => `${r.label}: ${r.outcome}`)).toEqual([
      "cc a/x.c: passed",
      "ruff check b: failed",
      "go vet: unavailable",
    ]);
  });

  test("optional: a missing toolchain is a note, and no matching file is not-applicable", () => {
    const shape = {
      coverage: {
        commands: [
          { files: ["a/**"], run: ["go", "vet"], optional: true },
          { files: ["none/**"], run: ["cc"], optional: true },
          { files: ["gone/**"], run: ["cc"] },
        ],
      },
    };
    const snapshot = repo(
      { ...TOOLS, "a/x.go": "" },
      { commands: [{ state: "unavailable", reason: "`go` is not on PATH" }] },
    );
    expect(checkCoverage(config(shape), snapshot).map((v) => `${v.rule} ${v.message}`)).toEqual([
      "coverage/command-unmatched declared command `cc` covers 'gone/**', which matches no file. Fix the glob, remove it, or set `optional: true` if its files may be absent.",
    ]);
    expect(commandReports(config(shape), snapshot).map((r) => r.outcome)).toEqual([
      "unavailable",
      "not-applicable",
      "failed",
    ]);
    expect(notices(config(shape), snapshot)).toContain(
      "skipped optional command `go vet`: `go` is not on PATH",
    );
  });

  test("a long failure keeps only the tail of its output", () => {
    const output = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const shape = { coverage: { commands: [{ files: ["a.c"], run: ["cc", "a.c"] }] } };
    const [found] = checkCoverage(
      config(shape),
      repo({ ...TOOLS, "a.c": "" }, { commands: [{ state: "ran", code: 1, output }] }),
    );
    expect(found?.message).toContain("(last 30 lines)\nline 70\n");
    expect(found?.message).not.toContain("line 69\n");
  });
});
