import { describe, expect, test } from "bun:test";
import { assess, notices, report } from "../../src/core/check.ts";
import {
  biomeCovers,
  checkCoverage,
  commandReports,
  tsconfigCovers,
} from "../../src/core/coverage.ts";
import { stripJsonc } from "../../src/core/jsonc.ts";
import { formatCheck } from "../../src/core/report.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
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
    expect(
      commandReports(config(shape), snapshot).map((r) => `${r.label}: ${r.outcome.state}`),
    ).toEqual(["cc a/x.c: passed", "ruff check b: failed", "go vet: unavailable"]);
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
    expect(commandReports(config(shape), snapshot).map((r) => r.outcome.state)).toEqual([
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

describe("review of #51", () => {
  const TOOLS = configs({}, {});

  test("optional with one glob unmatched still reports the run's own failure", () => {
    const shape = {
      coverage: {
        commands: [
          {
            files: ["native/**", "tools/**"],
            run: ["cc", "-fsyntax-only", "native/a.c"],
            optional: true,
          },
        ],
      },
    };
    const snapshot = repo(
      { ...TOOLS, "native/a.c": "int f(void){ return x; }" },
      { commands: [{ state: "ran", code: 1, output: "native/a.c:1:21: error: 'x' undeclared" }] },
    );
    expect(checkCoverage(config(shape), snapshot).map((v) => v.rule)).toEqual([
      "coverage/command-failed",
    ]);
    expect(commandReports(config(shape), snapshot).map((r) => r.outcome.state)).toEqual(["failed"]);
  });

  test("the mirror: optional, one glob unmatched, the run passes: green", () => {
    const shape = {
      coverage: { commands: [{ files: ["native/**", "tools/**"], run: ["cc"], optional: true }] },
    };
    const snapshot = repo(
      { ...TOOLS, "native/a.c": "" },
      { commands: [{ state: "ran", code: 0, output: "" }] },
    );
    expect(checkCoverage(config(shape), snapshot)).toEqual([]);
  });

  test("required, one glob unmatched, the run fails: both are reported", () => {
    const shape = { coverage: { commands: [{ files: ["native/**", "tools/**"], run: ["cc"] }] } };
    const snapshot = repo(
      { ...TOOLS, "native/a.c": "" },
      { commands: [{ state: "ran", code: 1, output: "error" }] },
    );
    expect(checkCoverage(config(shape), snapshot).map((v) => v.rule)).toEqual([
      "coverage/command-unmatched",
      "coverage/command-failed",
    ]);
  });

  test("an exemption names a directory the way a command's files do", () => {
    const shape = {
      coverage: { exemptFiles: [{ path: "scripts", reason: "one-off migrations, run by hand" }] },
    };
    expect(
      checkCoverage(config(shape), repo({ ...TOOLS, "scripts/a.py": "", "scripts/b/c.sh": "" })),
    ).toEqual([]);
  });

  test("an executable file's message says a binary needs an exemption, not a command", () => {
    const [found] = checkCoverage(
      config(),
      repo({ ...TOOLS, "lib/helper.so": "" }, { modes: { "lib/helper.so": "executable" } }),
    );
    expect(found?.message).toContain("a compiled binary");
    const [source] = checkCoverage(config(), repo({ ...TOOLS, "a.py": "" }));
    expect(source?.message).not.toContain("a compiled binary");
  });
});

describe("coverage's report under the outcome contract", () => {
  const TOOLS = configs({}, {});
  const shape: ShapeConfig = {
    prerequisites: { tsc: "optional", biome: "optional" },
    coverage: {
      commands: [
        { files: ["native/**"], run: ["cc", "-fsyntax-only", "native/a.c"] },
        { files: ["tools/**"], run: ["ruff", "check"], optional: true },
      ],
    },
  };

  test("a repo whose only source is C is examined, not not-applicable", () => {
    const snapshot = repo(
      { ...TOOLS, "native/a.c": "", "native/a.h": "", "tools/x.py": "" },
      {
        commands: [
          { state: "ran", code: 0, output: "" },
          { state: "unavailable", reason: "`ruff` is not on PATH" },
        ],
      },
    );
    const got = report("coverage", config(shape), snapshot);
    expect(got.outcome).toEqual({
      state: "passed",
      examined: "3 other source files against 2 declared commands",
    });
    expect(got.parts).toEqual([
      { label: "cc -fsyntax-only native/a.c", outcome: { state: "passed", examined: "2 files" } },
      {
        label: "ruff check",
        outcome: {
          state: "unavailable",
          prerequisite: "ruff",
          reason: "`ruff` is not on PATH",
          required: false,
        },
      },
    ]);
  });

  test("no TypeScript, no other source, no command: not-applicable, and no parts", () => {
    const none = config({ prerequisites: { tsc: "optional", biome: "optional" } });
    const got = report("coverage", none, repo({ ...TOOLS, "README.md": "" }));
    expect(got.outcome.state).toBe("not-applicable");
    expect(got.parts).toBeUndefined();
  });

  test("each command is one line under coverage in mshape check's output", () => {
    const snapshot = repo(
      { ...TOOLS, "native/a.c": "" },
      { commands: [{ state: "ran", code: 1, output: "native/a.c:1: error" }] },
    );
    const output = formatCheck(assess(config(shape), snapshot, {}, ["coverage"]));
    const lines = output.split("\n");
    const at = lines.findIndex((l) => l.trimStart().startsWith("coverage"));
    expect(lines[at]).toMatch(/^\s+coverage\s+failed/);
    // The states line up, however long a command is.
    expect(lines[at + 1]?.indexOf("failed")).toBe(lines[at]?.indexOf("failed"));
    expect(lines[at + 1]).toMatch(/^\s+cc -fsyntax-only native\/a\.c\s+failed\s+1 file/);
    expect(lines[at + 2]).toMatch(/^\s+ruff check\s+not-applicable\s+its files match nothing/);
  });
});

describe("review of the merge with #53", () => {
  test("a blocked coverage report still shows each command's line", () => {
    const shape: ShapeConfig = {
      coverage: { commands: [{ files: ["native/**"], run: ["cc", "native/a.c"] }] },
    };
    const snapshot = repo(
      { ...configs({}, {}), "src/a.ts": "", "native/a.c": "", "gen.py": "" },
      { commands: [{ state: "ran", code: 1, output: "native/a.c:1: error" }] },
    );
    const got = report("coverage", config(shape), snapshot);
    expect(got.outcome.state).toBe("unavailable");
    expect(got.parts).toEqual([
      { label: "cc native/a.c", outcome: { state: "failed", examined: "1 file" } },
    ]);
    // Why it failed is on screen too: the command's violations need neither tool.
    // So is uncovered source: everything that needs neither tool.
    expect(got.violations.map((v) => `${v.rule} ${v.file}`)).toEqual([
      "coverage/uncovered gen.py",
      "coverage/command-failed shape.config.ts",
    ]);
    expect(got.violations[1]?.message).toContain("native/a.c:1: error");
  });

  test("no TypeScript: no tsconfig.json or biome.json is asked for", () => {
    const shape: ShapeConfig = {
      prerequisites: { tsc: "optional", biome: "optional" },
      coverage: { commands: [{ files: ["native/**"], run: ["cc", "native/a.c"] }] },
    };
    const snapshot = repo(
      { "native/a.c": "", "vendor/x.ts": "" },
      { commands: [{ state: "ran", code: 0, output: "" }] },
    );
    expect(checkCoverage(config(shape), snapshot)).toEqual([]);
  });

  test("the mirror: with TypeScript, a missing tsconfig.json is still reported", () => {
    expect(
      checkCoverage(config(), repo({ "src/a.ts": "" })).map((v) => `${v.rule} ${v.file}`),
    ).toEqual(["coverage/config tsconfig.json", "coverage/config biome.json"]);
  });
});
