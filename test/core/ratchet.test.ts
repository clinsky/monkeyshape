import { describe, expect, test } from "bun:test";
import type { ChangedLines, Violation } from "../../src/core/model.ts";
import {
  applyBaseline,
  count,
  diffPath,
  parseChangedLines,
  tighten,
} from "../../src/core/ratchet.ts";

/** The ratchet keys on rule and file; `check` is the rule's own namespace, as checks set it. */
const v = (file: string, rule: Violation["rule"] = "rules/no-throw"): Violation =>
  ({ check: rule.slice(0, rule.indexOf("/")), rule, file, message: "m" }) as Violation;

describe("ratchet", () => {
  test("violations within the baseline are grandfathered", () => {
    const result = applyBaseline([v("a.ts"), v("a.ts")], { "rules/no-throw": { "a.ts": 2 } });
    expect(result).toEqual({ failing: [], loose: [], grandfathered: 2 });
  });

  test("one more than the baseline fails the whole file's group", () => {
    const result = applyBaseline([v("a.ts"), v("a.ts")], { "rules/no-throw": { "a.ts": 1 } });
    expect(result.failing.length).toBe(2);
    expect(result.failing[0]?.message).toContain("baseline allows 1");
  });

  test("new files and new rules have no allowance", () => {
    const result = applyBaseline([v("b.ts"), v("a.ts", "arch/cycle")], {
      "rules/no-throw": { "a.ts": 1 },
    });
    expect(result.failing.map((x) => `${x.rule} ${x.file}`)).toEqual([
      "rules/no-throw b.ts",
      "arch/cycle a.ts",
    ]);
  });

  // A loose ratchet is a failure, not a warning: D-strict-ratchet.
  test("fewer than the baseline is a loose ratchet", () => {
    const result = applyBaseline([v("a.ts")], { "rules/no-throw": { "a.ts": 3, "gone.ts": 1 } });
    expect(result.loose).toEqual([
      { rule: "rules/no-throw", file: "a.ts", allowed: 3, found: 1 },
      { rule: "rules/no-throw", file: "gone.ts", allowed: 1, found: 0 },
    ]);
  });

  test("rules this machine couldn't evaluate are neither loose nor tightened away", () => {
    const baseline = { "refs/bead-in-code": { "a.ts": 2 } };
    const skipped = new Set(["refs/bead-in-code"]);
    expect(applyBaseline([], baseline, skipped).loose).toEqual([]);
    expect(tighten(baseline, [], skipped)).toEqual(baseline);
  });

  test("tighten only lowers, and never adds new entries", () => {
    const baseline = { "rules/no-throw": { "a.ts": 3, "b.ts": 1 } };
    const now = [v("a.ts"), v("b.ts"), v("b.ts"), v("c.ts")];
    expect(tighten(baseline, now)).toEqual({ "rules/no-throw": { "a.ts": 1, "b.ts": 1 } });
  });

  test("count groups by rule and file", () => {
    expect(count([v("a.ts"), v("a.ts"), v("b.ts", "arch/cycle")])).toEqual({
      "rules/no-throw": { "a.ts": 2 },
      "arch/cycle": { "b.ts": 1 },
    });
  });
});

describe("over a baseline: the new occurrence", () => {
  const at = (line: number): Violation => ({ ...v("a.ts"), line });
  const three = [at(3), at(10), at(20)];
  const allowsTwo = { "rules/no-throw": { "a.ts": 2 } };
  const failing = (changed?: ChangedLines) =>
    applyBaseline(three, allowsTwo, new Set(), changed).failing.map((x) => [x.line, x.message]);

  test("one occurrence added on lines this branch changed: that one", () => {
    expect(failing(new Map([["a.ts", new Set([9, 10, 11])]]))).toEqual([
      [10, "m (baseline allows 2 here, found 3; this one is on a line this branch changed)"],
    ]);
  });

  test("the count rose, none on changed lines (moved code): every one, with a note", () => {
    const note =
      "m (baseline allows 2 here, found 3; none is on a line this branch changed, so each is listed)";
    expect(failing(new Map([["a.ts", new Set([4, 5])]]))).toEqual([
      [3, note],
      [10, note],
      [20, note],
    ]);
    expect(failing(new Map())).toEqual([
      [3, note],
      [10, note],
      [20, note],
    ]);
  });

  test("the count fell: nothing, and the ratchet is loose as before", () => {
    const result = applyBaseline([at(3)], allowsTwo, new Set(), new Map([["a.ts", new Set([3])]]));
    expect(result.failing).toEqual([]);
    expect(result.loose).toEqual([{ rule: "rules/no-throw", file: "a.ts", allowed: 2, found: 1 }]);
  });

  test("no merge base (a fresh repo): every occurrence", () => {
    expect(failing(undefined).map(([line]) => line)).toEqual([3, 10, 20]);
  });

  test("a new file counts all its lines as changed; a file the baseline doesn't know fails whole", () => {
    expect(failing(new Map([["a.ts", "all"]])).map(([line]) => line)).toEqual([3, 10, 20]);
    const fresh = applyBaseline([{ ...v("b.ts"), line: 1 }], allowsTwo, new Set(), new Map());
    expect(fresh.failing.map((x) => x.message)).toEqual(["m"]);
  });
});

describe("parseChangedLines", () => {
  test("the new side's lines per file; an added file whole; a pure deletion none", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 1..2 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -3 +3 @@ x",
      "-old",
      "+new",
      "@@ -10,0 +11,2 @@",
      "+one",
      "+two",
      "@@ -20,2 +22,0 @@",
      "-gone",
      "-gone",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
      "diff --git a/src/cut.ts b/src/cut.ts",
      "--- a/src/cut.ts",
      "+++ b/src/cut.ts",
      "@@ -5 +4,0 @@",
      "-x",
    ].join("\n");
    const changed = parseChangedLines(diff);
    expect(
      [...changed].map(([file, lines]) => [file, lines === "all" ? "all" : [...lines]]),
    ).toEqual([
      ["src/a.ts", [3, 11, 12]],
      ["src/new.ts", "all"],
    ]);
  });
});

describe("diffPath", () => {
  test("a plain path, one with a space (git ends it with a tab), and a quoted one", () => {
    expect(diffPath("b/src/a.ts")).toBe("src/a.ts");
    expect(diffPath("b/src/my file.ts\t")).toBe("src/my file.ts");
    expect(diffPath('"b/src/a\\"b.ts"')).toBe('src/a"b.ts');
    expect(diffPath('"b/src/back\\\\slash\\ttab.ts"')).toBe("src/back\\slash\ttab.ts");
    expect(diffPath('"b/src/caf\\303\\251.ts"')).toBe("src/café.ts");
  });

  test("not a new-side path: undefined", () => {
    expect(diffPath("/dev/null")).toBeUndefined();
    expect(diffPath('"b/bad\\q"')).toBeUndefined();
  });
});
