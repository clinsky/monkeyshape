/**
 * Ratchets let a rule land before the code is clean: existing violations are counted per
 * rule and file in a baseline, and counts may only go down. A count above the baseline
 * fails; a count below it fails too (the ratchet is loose) until `mshape baseline
 * --tighten` lowers it, so fixed violations can't silently come back.
 */
import type { Violation } from "./model.ts";

export type Counts = Readonly<Record<string, Readonly<Record<string, number>>>>;

export interface RatchetResult {
  readonly failing: ReadonlyArray<Violation>;
  readonly loose: ReadonlyArray<{
    readonly rule: string;
    readonly file: string;
    readonly allowed: number;
    readonly found: number;
  }>;
  readonly grandfathered: number;
}

export const count = (violations: ReadonlyArray<Violation>): Counts => {
  const counts: Record<string, Record<string, number>> = {};
  for (const v of violations) {
    const byFile = counts[v.rule] ?? {};
    byFile[v.file] = (byFile[v.file] ?? 0) + 1;
    counts[v.rule] = byFile;
  }
  return counts;
};

export const applyBaseline = (
  violations: ReadonlyArray<Violation>,
  baseline: Counts,
  unevaluated: ReadonlySet<string> = new Set(),
): RatchetResult => {
  const current = count(violations);
  const failing: Array<Violation> = [];
  const loose: Array<RatchetResult["loose"][number]> = [];
  let grandfathered = 0;
  for (const v of violations) {
    const allowed = baseline[v.rule]?.[v.file] ?? 0;
    const found = current[v.rule]?.[v.file] ?? 0;
    if (found > allowed)
      failing.push(
        allowed === 0
          ? v
          : { ...v, message: `${v.message} (baseline allows ${allowed} here, found ${found})` },
      );
    else grandfathered++;
  }
  for (const [rule, files] of Object.entries(baseline))
    for (const [file, allowed] of Object.entries(files)) {
      const found = current[rule]?.[file] ?? 0;
      if (found < allowed && !unevaluated.has(rule)) loose.push({ rule, file, allowed, found });
    }
  return { failing, loose, grandfathered };
};

/** Lowers counts to what is found now; never raises one or adds a new entry. */
export const tighten = (
  baseline: Counts,
  violations: ReadonlyArray<Violation>,
  unevaluated: ReadonlySet<string> = new Set(),
): Counts => {
  const current = count(violations);
  const next: Record<string, Record<string, number>> = {};
  for (const [rule, files] of Object.entries(baseline))
    for (const [file, allowed] of Object.entries(files)) {
      // Not counted on this machine: keep the entry rather than mistake it for fixed.
      const kept = unevaluated.has(rule) ? allowed : Math.min(allowed, current[rule]?.[file] ?? 0);
      if (kept > 0) next[rule] = { ...next[rule], [file]: kept };
    }
  return next;
};
