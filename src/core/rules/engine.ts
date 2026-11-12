/**
 * Custom rules run over the oxc AST. A rule reports offsets; the engine owns scope,
 * entry-file exemptions, per-rule allowances and inline `shape-ignore` comments, so every
 * rule gets the same escape hatches and every escape hatch carries a reason.
 *
 *   // shape-ignore no-throw: Bun.serve's fetch handler must throw to send a 500
 *
 * An ignore comment covers its own line and the next one.
 */
import { Visitor } from "oxc-parser";
import type { ResolvedConfig } from "../../schemas/config.ts";
import { matchesAny } from "../glob.ts";
import { lineAt, type Snapshot, type Violation } from "../model.ts";
import { type Parsed, parse } from "../parse.ts";
import { dirname, join } from "../paths.ts";
import { localRules } from "./local.ts";
import type { Finding, Rule, RuleContext } from "./rule.ts";

export type { Finding, Rule, RuleContext } from "./rule.ts";

/** Only a line comment that starts with the directive counts, so prose can mention it. */
const IGNORE = /^\s*shape-ignore\s+((?:local\/)?[a-z0-9-]+)(?::\s*(.*))?/;

interface Ignore {
  readonly rule: string;
  readonly line: number;
  readonly reason: string;
  used: boolean;
}

/**
 * What the engine itself reports, as `rules/<kind>`, beside each registry rule's own id; no
 * registry rule may take one of these ids. test/core/ruleCases.test.ts covers each.
 */
export const ENGINE_RULES = [
  "config",
  "syntax",
  "ignore-without-reason",
  "unused-ignore",
  "unused-allowance",
  "local-rule",
  "local-cases",
] as const;

const reported = (rule: string, file: string, line: number, message: string): Violation => ({
  check: "rules",
  rule: `rules/${rule}`,
  file,
  line,
  message,
});

const violation = (
  kind: (typeof ENGINE_RULES)[number],
  file: string,
  line: number,
  message: string,
): Violation => reported(kind, file, line, message);

/** Outside `checkRules` (one file, no repo): nothing beyond the file resolves. */
const ALONE: RuleContext = { resolve: () => undefined };

/** Resolves relative imports against the snapshot's texts, parsed through the shared cache. */
export const contextFor = (snapshot: Snapshot, path: string): RuleContext => ({
  resolve: (specifier) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
    const target = join(dirname(path), specifier);
    const text = target.startsWith("..") ? undefined : snapshot.texts.get(target);
    return text === undefined ? undefined : parse(target, text);
  },
});

const results = (
  rule: Rule,
  parsed: Parsed,
  context: RuleContext = ALONE,
): ReadonlyArray<Finding> | { readonly broken: string } => {
  if (rule.run !== undefined) return rule.run(parsed);
  const findings: Array<Finding> = [];
  new Visitor(rule.visit(parsed, (finding) => findings.push(finding), context)).visit(
    parsed.program,
  );
  return findings;
};

/** A rule's findings on one file; none when an adopter's rule broke on it. */
export const runRule = (rule: Rule, parsed: Parsed): ReadonlyArray<Finding> => {
  const found = results(rule, parsed);
  return "broken" in found ? [] : found;
};

export const checkRules = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  rules: ReadonlyArray<Rule>,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const local = localRules(config.localRules);
  for (const reason of local.broken)
    violations.push(violation("local-rule", config.configFile, 1, reason));
  const all = [...rules, ...local.rules];
  const active = all.filter(
    (rule) => config.layers.includes(rule.layer) && config.rules[rule.id]?.off === undefined,
  );
  for (const rule of active)
    for (const problem of local.cases.get(rule.id)?.(
      (config.rules[rule.id]?.allow ?? []).map((allowance) => allowance.path),
    ) ?? [])
      violations.push(violation("local-cases", config.configFile, 1, problem));
  const usedAllowances = new Set<string>();
  const known = new Set([...all.map((rule) => rule.id), ...local.brokenIds]);
  /** A local rule that broke: reported once, at the first file, with how many it broke on. */
  const brokeOn = new Map<string, { file: string; reason: string; files: number }>();

  for (const id of Object.keys(config.rules))
    if (!known.has(id))
      violations.push(violation("config", config.configFile, 1, `configures unknown rule '${id}'`));

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
    const context = contextFor(snapshot, file);
    for (const rule of active) {
      if (rule.entryExempt && entry) continue;
      const allowance = (config.rules[rule.id]?.allow ?? []).find((a) =>
        matchesAny(file, [a.path]),
      );
      const found = results(rule, parsed, context);
      if ("broken" in found) {
        // Its escape hatches here may be right: unchecked, they aren't unused.
        if (allowance !== undefined) usedAllowances.add(`${rule.id}\0${allowance.path}`);
        for (const ignore of ignores) if (ignore.rule === rule.id) ignore.used = true;
        const first = brokeOn.get(rule.id);
        if (first === undefined) brokeOn.set(rule.id, { file, reason: found.broken, files: 1 });
        else first.files++;
        continue;
      }
      for (const finding of found) {
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
        violations.push(reported(rule.id, file, line, finding.message ?? rule.message));
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

  for (const [id, { file, reason, files }] of brokeOn)
    violations.push(
      violation(
        "local-rule",
        file,
        1,
        `the rule ${id} broke on ${files === 1 ? "this file" : `${files} files, this one first`}: ${reason}. Fix the rule's check in its module; the files may be fine.`,
      ),
    );

  // A misshaped local rule never ran, so its allowances weren't tested, not unused. A rule
  // whose layer is off is different: `layers` is config, so its allowance is dead everywhere.
  const unrun = new Set(local.brokenIds);
  for (const [id, setting] of Object.entries(config.rules))
    for (const allowance of unrun.has(id) ? [] : (setting.allow ?? []))
      if (!usedAllowances.has(`${id}\0${allowance.path}`))
        violations.push(
          violation(
            "unused-allowance",
            config.configFile,
            1,
            `rules.${id}.allow '${allowance.path}' allows nothing; delete it`,
          ),
        );
  return violations;
};

/**
 * `mshape rules`: each rule with its layer (`local` for the repo's own) and the bug class it
 * removes, then a line for any `localRules` entry that isn't a rule, which `check` explains.
 */
export const formatRules = (
  rules: ReadonlyArray<Rule>,
  localEntries: ReadonlyArray<unknown> = [],
): string => {
  const local = localRules(localEntries);
  const width = Math.max(22, ...local.rules.map((rule) => rule.id.length + 2));
  const rows = [
    ...rules.map((rule) => `${rule.id.padEnd(width)}${rule.layer.padEnd(9)}${rule.bugClass}`),
    ...local.rules.map((rule) => `${rule.id.padEnd(width)}${"local".padEnd(9)}${rule.bugClass}`),
  ];
  const broken = local.broken.length;
  return broken === 0
    ? rows.join("\n")
    : [
        ...rows,
        "",
        `${broken} localRules ${broken === 1 ? "entry is" : "entries are"} not a rule: \`mshape check --only rules\` says why`,
      ].join("\n");
};

export interface RuleHatches {
  /** As violations carry it: `rules/<id>`, `rules/local/<id>` for the repo's own. */
  readonly rule: string;
  readonly ignores: number;
  readonly allowances: number;
}

/**
 * For garden: each local rule's escape hatches, the `shape-ignore` comments naming it in the
 * sources and its allowances in the config, so growth in one domain rule shows by name. A
 * local rule with none still has a row: garden lists every one the repo runs.
 */
export const localRuleHatches = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<RuleHatches> => {
  const ids = localRules(config.localRules).rules.map((rule) => rule.id);
  const ignores = new Map(ids.map((id) => [id, 0]));
  for (const file of snapshot.files) {
    if (!matchesAny(file, config.sources.include) || matchesAny(file, config.sources.exclude))
      continue;
    const text = snapshot.texts.get(file);
    if (text === undefined) continue;
    for (const comment of parse(file, text).comments) {
      const id = comment.type === "Line" ? IGNORE.exec(comment.value)?.[1] : undefined;
      const count = id === undefined ? undefined : ignores.get(id);
      if (id !== undefined && count !== undefined) ignores.set(id, count + 1);
    }
  }
  return ids.map((id) => ({
    rule: `rules/${id}`,
    ignores: ignores.get(id) ?? 0,
    allowances: config.rules[id]?.allow?.length ?? 0,
  }));
};
