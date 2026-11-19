/**
 * Adopter rules in `shape-rules/`, as the engine takes them from what the adapter ran: the
 * plan's "Adopter rules through ast-grep" table, case by case. ast-grep itself runs in
 * test/adapters/shapeRules.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { report } from "../../src/core/check.ts";
import type { ShapeRuleRun, ShapeRules, Snapshot } from "../../src/core/model.ts";
import { checkRules, formatRules, localRuleHatches } from "../../src/core/rules/engine.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, repo, ruled } from "../support.ts";

const SOURCE = [
  "export const a = (y: number | undefined) => {",
  "  const x = y!;",
  "  // shape-ignore local/no-bang: y was checked by the caller, two lines up",
  "  const z = y!;",
  "  return x + z;",
  "};",
  "",
].join("\n");

const CASES_RAN = {
  state: "ran",
  file: "shape-rules/no-bang.test.yml",
  runs: [
    { kind: "invalid", index: 1, matches: 1 },
    { kind: "valid", index: 1, matches: 0 },
  ],
} as const;

/** `no-bang`, matching lines 2 and 4 of src/a.ts, its cases as given. */
const rule = (over: Partial<ShapeRuleRun> = {}): ShapeRuleRun => ({
  file: "shape-rules/no-bang.yml",
  id: "no-bang",
  language: "typescript",
  message: "A non-null assertion hides undefined; narrow the type instead.",
  bugClass: "Crashes on values the types said were there.",
  matches: [
    { file: "src/a.ts", line: 2 },
    { file: "src/a.ts", line: 4 },
  ],
  cases: CASES_RAN,
  ...over,
});

const withRules = (
  rules: ReadonlyArray<ShapeRuleRun>,
  integration: ShapeRules["integration"] = { state: "ok" },
  files: Readonly<Record<string, string>> = { "src/a.ts": SOURCE },
): Snapshot => ({ ...repo(files), shapeRules: { integration, rules } });

const found = (snapshot: Snapshot, shape: ShapeConfig = {}) =>
  checkRules(config(shape), ruled(snapshot, [])).map(
    (v) => `${v.rule} ${v.file}:${v.line} ${v.message}`,
  );

describe("adopter rules through ast-grep", () => {
  test("a match outside an allowance is local/<id> at its line, with the rule's message", () => {
    expect(found(withRules([rule()]))).toEqual([
      "rules/local/no-bang src/a.ts:2 A non-null assertion hides undefined; narrow the type instead.",
    ]);
  });

  test("a match's own message, with the rule's metavariables filled in, is the one reported", () => {
    const named = rule({
      message: "reads $W.root; lend a directory instead.",
      matches: [{ file: "src/a.ts", line: 2, message: "reads st.root; lend a directory instead." }],
    });
    expect(found(withRules([named]))).toEqual([
      "rules/local/no-bang src/a.ts:2 reads st.root; lend a directory instead.",
      "rules/unused-ignore src/a.ts:3 shape-ignore local/no-bang suppresses nothing; delete it",
    ]);
  });

  test("a match under shape-ignore is suppressed; an unused one is reported", () => {
    const moved = rule({ matches: [{ file: "src/a.ts", line: 2 }] });
    expect(found(withRules([moved]))).toEqual([
      "rules/local/no-bang src/a.ts:2 A non-null assertion hides undefined; narrow the type instead.",
      "rules/unused-ignore src/a.ts:3 shape-ignore local/no-bang suppresses nothing; delete it",
    ]);
  });

  test("an allowance silences its paths, and one that silences nothing is reported", () => {
    expect(
      found(withRules([rule()]), {
        rules: {
          "local/no-bang": {
            allow: [{ path: "src/a.ts", reason: "a migration shim, until it goes" }],
          },
        },
      }),
    ).toEqual([
      "rules/unused-ignore src/a.ts:3 shape-ignore local/no-bang suppresses nothing; delete it",
    ]);
    expect(
      found(withRules([rule()]), {
        rules: {
          "local/no-bang": {
            allow: [{ path: "src/b.ts", reason: "a migration shim, until it goes" }],
          },
        },
      }),
    ).toContain(
      "rules/unused-allowance shape.config.ts:1 rules.local/no-bang.allow 'src/b.ts' allows nothing; delete it",
    );
  });

  test("a rule with no cases, or no invalid case, fails naming the file", () => {
    expect(found(withRules([rule({ cases: { state: "absent" } })]))).toContain(
      "rules/local-cases shape-rules/no-bang.yml:1 local/no-bang has no cases: add shape-rules/no-bang.test.yml with `valid:` (code close to the bug, on which it must report nothing) and `invalid:` (code with the bug, which it must report), at least one each",
    );
    const validOnly = rule({ cases: { ...CASES_RAN, runs: [CASES_RAN.runs[1]] } });
    expect(found(withRules([validOnly])).filter((v) => v.includes("local-cases"))).toEqual([
      "rules/local-cases shape-rules/no-bang.test.yml:1 local/no-bang has no invalid case: add one under `invalid:` in shape-rules/no-bang.test.yml; it holds `valid:` (code close to the bug, on which it must report nothing) and `invalid:` (code with the bug, which it must report), at least one each",
    ]);
  });

  test("a case that doesn't behave as labelled fails, naming the case", () => {
    const wrong = rule({
      cases: {
        ...CASES_RAN,
        runs: [
          { kind: "invalid", index: 1, matches: 0 },
          { kind: "valid", index: 1, matches: 2 },
        ],
      },
    });
    expect(found(withRules([wrong])).filter((v) => v.includes("local-cases"))).toEqual([
      "rules/local-cases shape-rules/no-bang.test.yml:1 local/no-bang's invalid case 1 reported nothing: the rule no longer catches the bug this case shows",
      "rules/local-cases shape-rules/no-bang.test.yml:1 local/no-bang's valid case 1 was reported 2 times: the rule fires on code it must accept",
    ]);
  });

  test("a rule ast-grep rejects fails with ast-grep's message, and its allowances aren't unused", () => {
    const rejected = rule({
      error: "Cannot parse rule shape-rules/no-bang.yml: unknown field `patern`",
      matches: [],
      cases: { state: "absent" },
    });
    expect(
      found(withRules([rejected]), {
        rules: {
          "local/no-bang": {
            allow: [{ path: "src/b.ts", reason: "a migration shim, until it goes" }],
          },
        },
      }),
    ).toEqual([
      "rules/local-rule shape-rules/no-bang.yml:1 does not run: Cannot parse rule shape-rules/no-bang.yml: unknown field `patern`",
      // The ignore names a rule that didn't run: the config still knows it, so nothing else.
      "rules/unused-ignore src/a.ts:3 shape-ignore local/no-bang suppresses nothing; delete it",
    ]);
  });

  test("an id that collides with a core rule fails, naming both", () => {
    const throwing = rule({ file: "shape-rules/no-throw.yml", id: "no-throw" });
    const problems = checkRules(config(), withRules([throwing])).filter(
      (v) => v.rule === "rules/local-rule",
    );
    expect(problems.map((v) => `${v.file}: ${v.message}`)).toEqual([
      "shape-rules/no-throw.yml: has id 'no-throw', which the core rule rules/no-throw has: rules/local/no-throw and rules/no-throw would read as one rule. Rename this one",
    ]);
  });

  test("a misshaped rule says what a rule file holds", () => {
    const named = rule({ file: "shape-rules/other.yml" });
    const noClass = rule({ bugClass: undefined });
    expect(found(withRules([named, noClass])).filter((v) => v.includes("local-rule"))).toEqual([
      "rules/local-rule shape-rules/other.yml:1 has id 'no-bang' but is named other.yml: rename the file to shape-rules/no-bang.yml, or the id to 'other'",
      'rules/local-rule shape-rules/no-bang.yml:1 needs a `metadata.bugClass` of at least 8 characters: a rule file is an ast-grep rule (`id`, `language`, `rule`, `message`) with `metadata: { bugClass: "<the class of bug it removes>" }`, named `shape-rules/<id>.yml` after its id',
    ]);
  });

  test("a rule in a language no listed pack reads is refused: it would never report", () => {
    // ast-grep reads YAML and finds the match; no listed pack claims deploy/ci.yml, so the
    // engine would drop it. Refused, so a rule never looks live while checking nothing.
    const yaml = rule({
      file: "shape-rules/no-target-trigger.yml",
      id: "no-target-trigger",
      language: "yaml",
      matches: [{ file: "deploy/ci.yml", line: 1 }],
      cases: { ...CASES_RAN, file: "shape-rules/no-target-trigger.test.yml" },
    });
    const snapshot = withRules(
      [yaml],
      { state: "ok" },
      {
        "src/a.ts": "export const a = 1;\n",
        "deploy/ci.yml": "on: { pull_request_target: {} }\n",
      },
    );
    expect(found(snapshot)).toEqual([
      "rules/local-rule shape-rules/no-target-trigger.yml:1 has `language: yaml`, which no listed pack reads (typescript reads TypeScript): the rules run over the files a listed pack claims, so it would never report. Write it in one of typescript, ts, tsx, or check those files with a command in `coverage.commands`",
    ]);
    // A listed pack's language, in any case ast-grep accepts: it runs.
    expect(found(withRules([rule({ language: "TSX" })]))[0]).toStartWith("rules/local/no-bang");
  });

  test("a rule turned off reports nothing, its cases unchecked", () => {
    const off = { rules: { "local/no-bang": { off: "superseded by the strict tsconfig" } } };
    expect(found(withRules([rule({ cases: { state: "absent" } })]), off)).toEqual([
      "rules/unused-ignore src/a.ts:3 shape-ignore local/no-bang suppresses nothing; delete it",
    ]);
  });

  test("no shape-rules/: nothing to run, and the check needs no ast-grep", () => {
    expect(report("rules", config(), repo({ "src/a.ts": SOURCE })).outcome.state).not.toBe(
      "unavailable",
    );
  });

  test("ast-grep that can't be had makes the rules check unavailable, and required", () => {
    const offline = withRules([], {
      state: "unavailable",
      reason: "ast-grep 0.51.1 is not in the cache and its download failed (offline)",
    });
    expect(report("rules", config(), offline).outcome).toEqual({
      state: "unavailable",
      prerequisite: "ast-grep",
      reason:
        "ast-grep 0.51.1 is not in the cache and its download failed (offline). It runs this repo's shape-rules/, so no rule ran, monkeyshape's own included",
      required: true,
    });
  });

  test("mshape rules and garden list each one by its file, with nothing run", () => {
    expect(
      formatRules(
        [],
        [{ id: "local/no-bang", bugClass: "Crashes on values the types said were there." }],
      ),
    ).toBe("local/no-bang         local    Crashes on values the types said were there.");
    const snapshot = repo({ "src/a.ts": SOURCE, "shape-rules/no-bang.yml": "id: no-bang\n" });
    expect(localRuleHatches(config(), snapshot)).toEqual([
      { rule: "rules/local/no-bang", ignores: 1, allowances: 0 },
    ]);
  });
});
