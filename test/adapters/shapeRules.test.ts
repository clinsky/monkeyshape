/**
 * `shape-rules/` through the real ast-grep `mshape` pins: fetched into an empty cache, run
 * over a repo and over each case, refused when a rule is wrong, and never fetched for a repo
 * with no rules. The engine's side is test/core/shapeRules.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { loadShapeRules } from "../../src/adapters/shapeRules.ts";
import { cacheRoot } from "../../src/core/launch.ts";
import { AST_GREP, type ToolPin } from "../../src/core/tools.ts";

let work = "";
/** A cache no ast-grep was ever fetched into, shared by the cases that need one fetched. */
let fresh = "";

const RULE = `id: no-unwrap
language: rust
rule:
  pattern: $X.unwrap()
message: unwrap panics on None; return the error to the caller instead
metadata:
  bugClass: Panics in library code
`;

const CASES = `valid:
  - "let x = y?;"
invalid:
  - "let x = y.unwrap();"
  - "let z = a.b().unwrap();"
`;

/** Line 3 holds the match, below a line with a two-byte character. */
const LIB = "pub fn f(y: Option<u8>) -> u8 {\n    // é, before the match\n    y.unwrap()\n}\n";

/** A pin whose downloads can't be had: what an offline machine sees. */
const OFFLINE: ToolPin = {
  ...AST_GREP,
  downloads: {
    "linux-x64": { url: "http://127.0.0.1:9/ast-grep.tgz", sha256: "0".repeat(64) },
    "linux-arm64": { url: "http://127.0.0.1:9/ast-grep.tgz", sha256: "0".repeat(64) },
    "darwin-arm64": { url: "http://127.0.0.1:9/ast-grep.tgz", sha256: "0".repeat(64) },
  },
};

const write = async (repo: string, files: Readonly<Record<string, string>>) => {
  for (const [path, text] of Object.entries(files)) await Bun.write(join(repo, path), text);
  return Object.keys(files);
};

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "mshape-shape-rules-"));
  fresh = join(work, "cache");
});

afterAll(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("shape-rules through ast-grep", () => {
  test("no rule files: nothing runs, and ast-grep isn't fetched", async () => {
    const repo = join(work, "none");
    const files = await write(repo, { "src/lib.rs": LIB, "shape-rules/README.md": "notes\n" });
    const empty = join(work, "untouched-cache");
    expect(await Effect.runPromise(loadShapeRules(repo, files, empty, OFFLINE))).toBeUndefined();
    expect(await Bun.file(join(empty, "tools")).exists()).toBe(false);
  });

  test("offline with no cache: unavailable, saying how to get it", async () => {
    const repo = join(work, "offline");
    const files = await write(repo, { "src/lib.rs": LIB, "shape-rules/no-unwrap.yml": RULE });
    const loaded = await Effect.runPromise(
      loadShapeRules(repo, files, join(work, "offline-cache"), OFFLINE),
    );
    expect(loaded?.rules).toEqual([]);
    expect(loaded?.integration).toMatchObject({ state: "unavailable" });
    expect(JSON.stringify(loaded?.integration)).toContain("connect and rerun");
  });

  test("an empty cache: ast-grep is fetched, and each rule and case runs", async () => {
    const repo = join(work, "rules");
    const files = await write(repo, {
      "src/lib.rs": LIB,
      "shape-rules/no-unwrap.yml": RULE,
      "shape-rules/no-unwrap.test.yml": CASES,
      // A rule of severity error: ast-grep exits 1 with its matches, which still count.
      "shape-rules/no-expect.yml": `${RULE.replace("no-unwrap", "no-expect").replace("$X.unwrap()", "$X.expect($$$A)")}severity: error\n`,
      "shape-rules/no-expect.test.yml": 'valid:\n  - "y?"\ninvalid:\n  - "y.expect(\\"set\\")"\n',
      "shape-rules/misspelt.yml": "id: misspelt\nlanguage: rust\nrule:\n  patern: x\n",
      "shape-rules/not-yaml.yml": "id: [unclosed\n",
      // ast-grep takes `---`-separated rules; monkeyshape pairs one file with one rule.
      "shape-rules/two.yml": `${RULE.replace("no-unwrap", "two")}---\n${RULE.replace("no-unwrap", "three")}`,
    });
    const loaded = await Effect.runPromise(loadShapeRules(repo, files, fresh));
    expect(loaded?.integration).toEqual({ state: "ok" });
    const byId = new Map(loaded?.rules.map((rule) => [rule.file, rule]));

    expect(byId.get("shape-rules/no-unwrap.yml")).toEqual({
      file: "shape-rules/no-unwrap.yml",
      id: "no-unwrap",
      language: "rust",
      message: "unwrap panics on None; return the error to the caller instead",
      bugClass: "Panics in library code",
      matches: [{ file: "src/lib.rs", line: 3 }],
      cases: {
        state: "ran",
        file: "shape-rules/no-unwrap.test.yml",
        runs: [
          { kind: "invalid", index: 1, matches: 1 },
          { kind: "invalid", index: 2, matches: 1 },
          { kind: "valid", index: 1, matches: 0 },
        ],
      },
    });
    expect(byId.get("shape-rules/no-expect.yml")).toMatchObject({
      matches: [],
      cases: {
        state: "ran",
        runs: [
          { kind: "invalid", index: 1, matches: 1 },
          { kind: "valid", index: 1, matches: 0 },
        ],
      },
    });
    expect(byId.get("shape-rules/no-expect.yml")?.error).toBeUndefined();
    expect(byId.get("shape-rules/misspelt.yml")?.error).toContain("unknown field `patern`");
    expect(byId.get("shape-rules/not-yaml.yml")?.error).toStartWith("it is not YAML: ");
    expect(byId.get("shape-rules/two.yml")?.error).toBe(
      "it holds 2 rules: one rule per file, so each has its own id, file and cases. Split it into shape-rules/<id>.yml files",
    );
  }, 120_000);

  test("a cases file that isn't lists of snippets is invalid, naming the key", async () => {
    const repo = join(work, "bad-cases");
    const files = await write(repo, {
      "src/lib.rs": LIB,
      "shape-rules/no-unwrap.yml": RULE,
      "shape-rules/no-unwrap.test.yml": "valid: one snippet\n",
    });
    const cache = cacheRoot(
      { XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"], HOME: process.env["HOME"] },
      tmpdir(),
    );
    const loaded = await Effect.runPromise(loadShapeRules(repo, files, cache));
    expect(loaded?.rules[0]?.cases).toEqual({
      state: "invalid",
      file: "shape-rules/no-unwrap.test.yml",
      reason: "`valid` is not a list of source snippets",
    });
  }, 120_000);
});
