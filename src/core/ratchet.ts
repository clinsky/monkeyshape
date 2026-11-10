/**
 * Ratchets let a rule land before the code is clean: existing violations are counted per
 * rule and file in a baseline, and counts may only go down. A count above the baseline
 * fails; a count below it fails too (the ratchet is loose) until `mshape baseline
 * --tighten` lowers it, so fixed violations can't silently come back.
 */
import type { ChangedLines, Violation } from "./model.ts";

/** The new side's lines in a `git diff -U0` against the merge base, by the file they land in. */
export const parseChangedLines = (diff: string): ChangedLines => {
  const changed = new Map<string, Set<number> | "all">();
  let file: string | undefined;
  let added = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
      added = false;
    } else if (line === "--- /dev/null") added = true;
    else if (line.startsWith("+++ b/")) {
      file = line.slice("+++ b/".length);
      if (added) changed.set(file, "all");
    } else if (line.startsWith("@@ ") && file !== undefined && !added) {
      const match = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (match === null) continue;
      const start = Number(match[1]);
      const length = match[2] === undefined ? 1 : Number(match[2]);
      const lines = changed.get(file);
      const set = lines instanceof Set ? lines : new Set<number>();
      for (let n = start; n < start + length; n++) set.add(n);
      if (length > 0) changed.set(file, set);
    }
  }
  return changed;
};

const onChangedLine = (v: Violation, changed: ChangedLines): boolean => {
  const lines = changed.get(v.file);
  return lines === "all" || (lines !== undefined && v.line !== undefined && lines.has(v.line));
};

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

/**
 * A rule's count in a file above its baseline fails. Where the baseline allows some, only the
 * occurrences on lines this branch changed are reported, since those are the new ones; when
 * none is (moved code, or no `changed` to tell), each one is, with a note saying why.
 */
export const applyBaseline = (
  violations: ReadonlyArray<Violation>,
  baseline: Counts,
  unevaluated: ReadonlySet<string> = new Set(),
  changed?: ChangedLines,
): RatchetResult => {
  const current = count(violations);
  const failing: Array<Violation> = [];
  const loose: Array<RatchetResult["loose"][number]> = [];
  let grandfathered = 0;
  /** Whether any occurrence of the rule in the file is on a changed line, by `rule\0file`. */
  const anyChanged = new Set<string>();
  if (changed !== undefined)
    for (const v of violations)
      if (onChangedLine(v, changed)) anyChanged.add(`${v.rule}\0${v.file}`);
  for (const v of violations) {
    const allowed = baseline[v.rule]?.[v.file] ?? 0;
    const found = current[v.rule]?.[v.file] ?? 0;
    if (found <= allowed) {
      grandfathered++;
      continue;
    }
    if (allowed === 0) {
      failing.push(v);
      continue;
    }
    const byLine = changed !== undefined && anyChanged.has(`${v.rule}\0${v.file}`);
    if (byLine && !onChangedLine(v, changed)) {
      grandfathered++;
      continue;
    }
    const why =
      changed === undefined
        ? ""
        : byLine
          ? "; this one is on a line this branch changed"
          : "; none is on a line this branch changed, so each is listed";
    failing.push({
      ...v,
      message: `${v.message} (baseline allows ${allowed} here, found ${found}${why})`,
    });
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
