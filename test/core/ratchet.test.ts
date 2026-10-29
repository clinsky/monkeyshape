import { describe, expect, test } from "bun:test";
import type { Violation } from "../../src/core/model.ts";
import { applyBaseline, count, tighten } from "../../src/core/ratchet.ts";

const v = (file: string, rule = "rules/no-throw"): Violation => ({
  check: "rules",
  rule,
  file,
  message: "m",
});

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
