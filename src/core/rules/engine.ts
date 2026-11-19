/**
 * Custom rules run over the oxc AST. A rule reports offsets; the engine owns scope,
 * entry-file exemptions, per-rule allowances and inline `shape-ignore` comments, so every
 * rule gets the same escape hatches and every escape hatch carries a reason. Not Biome
 * plugins, which have no per-path allowances or counts: D-own-rule-engine.
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
import { claimOf } from "../sources.ts";
import type { Finding, Rule, RuleContext } from "./rule.ts";
import { isShapeRuleFile, shapeRuleSet } from "./shapeRules.ts";

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

/** The rule a cases problem is about, `local/<id>`, from its file, so `off` silences it. */
const idOf = (problem: { readonly file: string }): string =>
  `local/${(problem.file.split("/").at(-1) ?? "").replace(/(\.test)?\.ya?ml$/u, "")}`;

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

/**
 * Each file's claiming pack's own rules and the repo's `shape-rules/`, with
 * the engine's scope, allowances and `shape-ignore` around them all.
 */
export const checkRules = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const on = (rule: { readonly id: string; readonly layer: string }) =>
    (config.layers as ReadonlyArray<string>).includes(rule.layer) &&
    config.rules[rule.id]?.off === undefined;
  const packRules = snapshot.packs.flatMap(({ pack }) => pack.rules);
  const all = packRules;
  // The repo's shape-rules/, run by ast-grep: problems, then rules by their matches.
  const shape = shapeRuleSet(
    snapshot.shapeRules,
    new Set(all.map((rule) => rule.id)),
    snapshot.packs.map(({ pack }) => ({ id: pack.id, language: pack.language })),
  );
  for (const problem of shape.problems)
    if (problem.kind === "local-rule" || config.rules[idOf(problem)]?.off === undefined)
      violations.push(violation(problem.kind, problem.file, 1, problem.message));
  const shapeActive = shape.rules.filter((rule) => config.rules[rule.id]?.off === undefined);
  const usedAllowances = new Set<string>();
  const known = new Set([
    ...all.map((rule) => rule.id),
    ...shape.rules.map((rule) => rule.id),
    ...shape.unrun,
  ]);

  for (const id of Object.keys(config.rules))
    if (!known.has(id))
      violations.push(violation("config", config.configFile, 1, `configures unknown rule '${id}'`));

  for (const file of snapshot.files) {
    if (!matchesAny(file, config.sources.include) || matchesAny(file, config.sources.exclude))
      continue;
    const text = snapshot.texts.get(file);
    // A file no listed pack claims has no language here to parse it in.
    const claim = claimOf(snapshot, file);
    if (text === undefined || claim === undefined) continue;
    const pack = claim.loaded.pack;
    const source = { path: file, text };
    for (const error of pack.syntaxErrors(source))
      violations.push(violation("syntax", file, 1, `does not parse: ${error}`));

    const ignores: Array<Ignore> = [];
    for (const comment of pack.comments(source)) {
      const match = comment.kind === "line" ? IGNORE.exec(comment.text) : null;
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

    const allowanceOf = (id: string) =>
      (config.rules[id]?.allow ?? []).find((a) => matchesAny(file, [a.path]));
    /** A finding at `line`, unless an allowance or a `shape-ignore` covers it. */
    const report = (id: string, line: number, message: string) => {
      const allowance = allowanceOf(id);
      if (allowance !== undefined) {
        usedAllowances.add(`${id}\0${allowance.path}`);
        return;
      }
      const ignore = ignores.find((i) => i.rule === id && (i.line === line || i.line === line - 1));
      if (ignore !== undefined) {
        ignore.used = true;
        return;
      }
      violations.push(reported(id, file, line, message));
    };
    for (const rule of shapeActive)
      for (const match of rule.lines.get(file) ?? [])
        report(rule.id, match.line, match.message ?? rule.message);

    const entry = matchesAny(file, config.entry);
    // The claiming pack's own rules, each over the file's text, in the pack's language.
    for (const rule of pack.rules) {
      if (!on(rule) || (rule.entryExempt && entry)) continue;
      for (const finding of rule.run(source, snapshot.texts))
        report(rule.id, lineAt(text, finding.offset), finding.message ?? rule.message);
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

  // A misshaped local rule never ran, so its allowances weren't tested, not unused. A rule
  // whose layer is off is different: `layers` is config, so its allowance is dead everywhere.
  const unrun = new Set(shape.unrun);
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
 * `mshape rules`: each rule with its layer (`local` for the repo's own, in `shape-rules/`) and
 * the bug class it removes.
 */
export const formatRules = (
  rules: ReadonlyArray<{ readonly id: string; readonly layer: string; readonly bugClass: string }>,
  shapeRules: ReadonlyArray<{ readonly id: string; readonly bugClass: string }> = [],
): string => {
  const width = Math.max(22, ...shapeRules.map((rule) => rule.id.length + 2));
  return [
    ...rules.map((rule) => `${rule.id.padEnd(width)}${rule.layer.padEnd(9)}${rule.bugClass}`),
    ...shapeRules.map((rule) => `${rule.id.padEnd(width)}${"local".padEnd(9)}${rule.bugClass}`),
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
 * local rule with none still has a row: garden lists every one the repo runs. A
 * `shape-rules/` rule is named by its file, so garden needn't run ast-grep.
 */
export const localRuleHatches = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<RuleHatches> => {
  const ids = [
    ...new Set([
      ...snapshot.files
        .filter(isShapeRuleFile)
        .map((file) => `local/${(file.split("/").at(-1) ?? "").replace(/\.ya?ml$/u, "")}`),
    ]),
  ];
  const ignores = new Map(ids.map((id) => [id, 0]));
  for (const file of snapshot.files) {
    if (!matchesAny(file, config.sources.include) || matchesAny(file, config.sources.exclude))
      continue;
    const text = snapshot.texts.get(file);
    const claim = claimOf(snapshot, file);
    if (text === undefined || claim === undefined) continue;
    for (const comment of claim.loaded.pack.comments({ path: file, text })) {
      const id = comment.kind === "line" ? IGNORE.exec(comment.text)?.[1] : undefined;
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
