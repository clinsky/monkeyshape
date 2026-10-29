/**
 * Custom rules run over the oxc AST. A rule reports offsets; the engine owns scope,
 * entry-file exemptions, per-rule allowances and inline `shape-ignore` comments, so every
 * rule gets the same escape hatches and every escape hatch carries a reason.
 *
 *   // shape-ignore no-throw: Bun.serve's fetch handler must throw to send a 500
 *
 * An ignore comment covers its own line and the next one.
 */
import type { VisitorObject } from "oxc-parser";
import { Visitor } from "oxc-parser";
import type { ResolvedConfig } from "../../schemas/config.ts";
import { matchesAny } from "../glob.ts";
import { lineAt, type Snapshot, type Violation } from "../model.ts";
import { type Parsed, parse } from "../parse.ts";

export interface Finding {
  readonly offset: number;
  /** Overrides the rule's message for this finding. */
  readonly message?: string;
}

export interface Rule {
  readonly id: string;
  readonly layer: "core" | "agentic";
  /** The class of bug this rule removes, for the registry and `mshape rules`. */
  readonly bugClass: string;
  /** Why, and what to do instead. Shown with every violation. */
  readonly message: string;
  /** Whether composition roots (`entry`) are exempt. */
  readonly entryExempt: boolean;
  readonly visit: (parsed: Parsed, report: (finding: Finding) => void) => VisitorObject;
}

/** Only a line comment that starts with the directive counts, so prose can mention it. */
const IGNORE = /^\s*shape-ignore\s+([a-z0-9-]+)(?::\s*(.*))?/;

interface Ignore {
  readonly rule: string;
  readonly line: number;
  readonly reason: string;
  used: boolean;
}

const violation = (rule: string, file: string, line: number, message: string): Violation => ({
  check: "rules",
  rule: `rules/${rule}`,
  file,
  line,
  message,
});

export const runRule = (rule: Rule, parsed: Parsed): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];
  new Visitor(rule.visit(parsed, (finding) => findings.push(finding))).visit(parsed.program);
  return findings;
};

export const checkRules = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  rules: ReadonlyArray<Rule>,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const active = rules.filter(
    (rule) => config.layers.includes(rule.layer) && config.rules[rule.id]?.off === undefined,
  );
  const usedAllowances = new Set<string>();
  const known = new Set(rules.map((rule) => rule.id));

  for (const id of Object.keys(config.rules))
    if (!known.has(id))
      violations.push(violation("config", "shape.config.ts", 1, `configures unknown rule '${id}'`));

  for (const file of snapshot.files) {
    if (!matchesAny(file, config.sources.include) || matchesAny(file, config.sources.exclude))
      continue;
    const text = snapshot.texts.get(file);
    if (text === undefined) continue;
    const parsed = parse(file, text);
    for (const error of parsed.syntaxErrors)
      violations.push(violation("syntax", file, 1, `does not parse: ${error}`));

    const ignores: Array<Ignore> = [];
    for (const comment of parsed.comments) {
      const match = comment.type === "Line" ? IGNORE.exec(comment.value) : null;
      if (match === null) continue;
      const reason = (match[2] ?? "").trim();
      const line = lineAt(text, comment.end);
      if (reason.length < 8) {
        violations.push(
          violation(
            "ignore-without-reason",
            file,
            line,
            "a shape-ignore needs `: <reason>` a later agent can weigh",
          ),
        );
        continue;
      }
      ignores.push({ rule: match[1] ?? "", line, reason, used: false });
    }

    const entry = matchesAny(file, config.entry);
    for (const rule of active) {
      if (rule.entryExempt && entry) continue;
      const allowance = (config.rules[rule.id]?.allow ?? []).find((a) =>
        matchesAny(file, [a.path]),
      );
      for (const finding of runRule(rule, parsed)) {
        if (allowance !== undefined) {
          usedAllowances.add(`${rule.id}\0${allowance.path}`);
          continue;
        }
        const line = lineAt(text, finding.offset);
        const ignore = ignores.find(
          (i) => i.rule === rule.id && (i.line === line || i.line === line - 1),
        );
        if (ignore !== undefined) {
          ignore.used = true;
          continue;
        }
        violations.push(violation(rule.id, file, line, finding.message ?? rule.message));
      }
    }
    for (const ignore of ignores)
      if (!ignore.used)
        violations.push(
          violation(
            "unused-ignore",
            file,
            ignore.line,
            `shape-ignore ${ignore.rule} suppresses nothing; delete it`,
          ),
        );
  }

  for (const [id, setting] of Object.entries(config.rules))
    for (const allowance of setting.allow ?? [])
      if (!usedAllowances.has(`${id}\0${allowance.path}`))
        violations.push(
          violation(
            "unused-allowance",
            "shape.config.ts",
            1,
            `rules.${id}.allow '${allowance.path}' allows nothing; delete it`,
          ),
        );
  return violations;
};
