/**
 * `DECISIONS.md` entries: `## D-<slug>: <title>` followed by fixed fields. Parsing is
 * line-based on purpose, so a malformed entry is reported rather than skipped.
 */

export const FIELDS = [
  "Decision",
  "Tempting wrong fix",
  "Evidence",
  "Enforced by",
  "Revisit when",
] as const;
export type Field = (typeof FIELDS)[number];

export const EVIDENCE_KINDS = ["measured", "verified", "policy"] as const;

export interface Decision {
  readonly slug: string;
  readonly title: string;
  readonly line: number;
  readonly words: number;
  readonly fields: ReadonlyMap<Field, string>;
  readonly evidence: string | undefined;
  /** First token of each comma-separated item in "Enforced by", backticks stripped. */
  readonly enforcedBy: ReadonlyArray<string>;
}

export const SLUG = /^D-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEADING = /^## +(\S+?):? +(.*)$/;

export const parseDecisions = (text: string): ReadonlyArray<Decision> => {
  const lines = text.split("\n");
  const decisions: Array<Decision> = [];
  let current: { slug: string; title: string; line: number; body: Array<string> } | undefined;

  const finish = () => {
    if (current === undefined) return;
    const fields = new Map<Field, string>();
    for (const line of current.body)
      for (const field of FIELDS)
        if (line.startsWith(`${field}:`)) fields.set(field, line.slice(field.length + 1).trim());
    const evidence = /^[a-z]+/.exec((fields.get("Evidence") ?? "").toLowerCase())?.[0];
    const enforcedBy = (fields.get("Enforced by") ?? "")
      .split(",")
      .map((item) => (item.trim().split(/\s+/)[0] ?? "").replaceAll("`", ""))
      .filter((item) => item.length > 0 && !/^(none|n\/a|-|—)$/i.test(item));
    const words = current.body.join(" ").split(/\s+/).filter(Boolean).length;
    decisions.push({ ...current, words, fields, evidence, enforcedBy });
  };

  lines.forEach((line, index) => {
    const heading = line.startsWith("## ") ? HEADING.exec(line) : null;
    if (heading !== null || line.startsWith("# ")) {
      finish();
      current =
        heading === null
          ? undefined
          : { slug: heading[1] ?? "", title: heading[2] ?? "", line: index + 1, body: [] };
      return;
    }
    current?.body.push(line);
  });
  finish();
  return decisions;
};
