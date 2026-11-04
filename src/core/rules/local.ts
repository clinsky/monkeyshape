/**
 * Adopter rules: a repo's own rules, in its own files, run by the same engine as the
 * registry's. `shape.config.ts` imports each module and lists it in `localRules`; the engine
 * validates its shape and namespaces its id as `local/<id>`, then scope, allowances and
 * `shape-ignore` apply to it exactly as to a registry rule.
 *
 * The interface is the ESTree tree oxc produces (types only) and `walk`: oxc's parse
 * function, its Visitor class and its module records stay private.
 */
import type { Expression, Node, Program, VisitorObject } from "oxc-parser";
import { Visitor } from "oxc-parser";
import { matchesAny } from "../glob.ts";
import { lineAt } from "../model.ts";
import { parse } from "../parse.ts";
import type { Finding, Rule } from "./rule.ts";

export type { Expression, Finding, Node, Program };

/** Handlers by node type, e.g. `{ CallExpression: (node) => ... }`, each given a typed node. */
export type Visitors = VisitorObject;

/** What a local rule is given: one file in the rules' scope, parsed. */
export interface SourceFile {
  /** Repo-relative. */
  readonly path: string;
  readonly text: string;
  readonly program: Program;
}

/** What a local rule module exports: what a registry rule has, and nothing more. */
export interface LocalRule {
  /** Lowercase words joined by hyphens; reported, configured and ignored as `local/<id>`. */
  readonly id: string;
  /** The class of bug the rule removes, for `mshape rules`. */
  readonly bugClass: string;
  /** Why, and what to do instead. Shown with every violation. */
  readonly message: string;
  /**
   * Each violation in the file: its offset (UTF-16, as `node.start`), or `{ offset, message }`
   * to say more than the rule's message for this one.
   */
  readonly check: (file: SourceFile) => Iterable<number | Finding>;
  /**
   * Sources the rule is run on at every `mshape check`, so it can't silently stop catching its
   * bug or start firing on valid code. A case is source text, or `{ path, source }` when the
   * rule looks at the path (default path `src/case.ts`).
   */
  readonly cases: {
    /** Each has the bug, and must be reported at least once. At least one. */
    readonly fail: ReadonlyArray<Case>;
    /** Valid code close to the bug, on which nothing may be reported. At least one. */
    readonly pass: ReadonlyArray<Case>;
    /**
     * The exceptions the rule makes on purpose, such as the enforcement point itself: code
     * that looks like the bug and must not be reported. Needed when the rule makes one. The
     * exception may be in `check` or in the config's `rules["local/<id>"].allow`: a case
     * whose path the config allows reports nothing, as in a real run.
     */
    readonly allowed?: ReadonlyArray<Case>;
  };
}

export type Case = string | { readonly path: string; readonly source: string };

/** Identity, for type-checking a rule module: `export default defineRule({ ... })`. */
export const defineRule = (rule: LocalRule): LocalRule => rule;

/** Calls each handler on every node of its type, depth first, parents before children. */
export const walk = (program: Program, visitors: Visitors): void => {
  new Visitor(visitors).visit(program);
};

export const LOCAL_PREFIX = "local/";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const SHAPE =
  'a rule module does `export default defineRule({ id, bugClass, message, check })` (from monkeyshape): `id` in lowercase words joined by hyphens, `bugClass` and `message` as sentences, `check` a synchronous function from a file to its offsets. shape.config.ts imports it (`import rule from "./rules/x.ts"`) and lists `rule` in `localRules`';

/** The likely mistake behind an entry that isn't a rule, said before the shape. */
const hint = (value: unknown): string => {
  if (typeof value === "string")
    return " (a path: import the module and list what it exports, not its path)";
  if (typeof value === "object" && value !== null && "default" in value)
    return " (a module namespace, as `import * as`: list its default export instead)";
  return "";
};

/** Why `value` is not a local rule, or undefined if it is one. */
const problem = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null || "default" in value)
    return `is ${typeof value === "object" && value !== null ? "a module namespace" : typeof value}, not a rule${hint(value)}`;
  const rule = value as Partial<Record<keyof LocalRule, unknown>>;
  if (typeof rule.id !== "string" || !ID.test(rule.id))
    return `its id ${JSON.stringify(rule.id)} is not lowercase words joined by hyphens`;
  for (const key of ["bugClass", "message"] as const) {
    const text = rule[key];
    if (typeof text !== "string" || text.trim().length < 8)
      return `'${rule.id}' needs a \`${key}\` of at least 8 characters`;
  }
  if (typeof rule.check !== "function") return `'${rule.id}' needs a \`check\` function`;
  return undefined;
};

/** The first frame of a stack outside monkeyshape and oxc: where in the rule it threw. */
const ruleFrame = (cause: unknown): string | undefined => {
  if (!(cause instanceof Error) || cause.stack === undefined) return undefined;
  for (const line of cause.stack.split("\n").slice(1)) {
    const at = /\(?((?:\/|[A-Za-z]:)[^()]*:\d+:\d+)\)?\s*$/.exec(line.trim())?.[1];
    if (at === undefined || /\/oxc-parser\/|\/core\/rules\/(?:local|engine)\.ts:/.test(at))
      continue;
    return at;
  }
  return undefined;
};

/** For a reason: what a rule returned, even when JSON can't say it (a BigInt, a cycle). */
const shown = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
};

const asFinding = (value: unknown, length: number): Finding | undefined => {
  if (typeof value === "number") return asFinding({ offset: value }, length);
  if (typeof value !== "object" || value === null) return undefined;
  const { offset, message } = value as { offset?: unknown; message?: unknown };
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0 || offset > length)
    return undefined;
  if (message !== undefined && typeof message !== "string") return undefined;
  return message === undefined ? { offset } : { offset, message };
};

/** A valid local rule as an engine rule; what it throws or returns wrong is a reason, not raised. */
const toRule = (local: LocalRule): Rule => ({
  id: `${LOCAL_PREFIX}${local.id}`,
  layer: "core",
  bugClass: local.bugClass,
  message: local.message,
  entryExempt: false,
  visit: () => ({}),
  run: (parsed) => {
    let results: ReadonlyArray<unknown>;
    try {
      const returned: unknown = local.check({
        path: parsed.path,
        text: parsed.text,
        program: parsed.program,
      });
      if (typeof returned === "object" && returned !== null && "then" in returned) {
        // Handled, so a rejection can't surface later as an unhandled one and kill the run.
        Promise.resolve(returned).catch(() => undefined);
        return {
          broken:
            "`check` returned a Promise: it must be synchronous, returning the offsets directly",
        };
      }
      if (typeof returned !== "object" || returned === null || !(Symbol.iterator in returned))
        return { broken: `it returned ${shown(returned)}, not a list of offsets` };
      results = [...(returned as Iterable<unknown>)];
    } catch (cause) {
      const frame = ruleFrame(cause);
      return { broken: `it threw ${String(cause)}${frame === undefined ? "" : ` at ${frame}`}` };
    }
    const findings: Array<Finding> = [];
    for (const result of results) {
      const finding = asFinding(result, parsed.text.length);
      if (finding === undefined)
        return {
          broken: `it returned ${shown(result)} in its list, not an offset inside the file or \`{ offset, message? }\``,
        };
      findings.push(finding);
    }
    return findings;
  },
});

const CASE_PATH = "src/case.ts";

const KINDS = {
  fail: "must-fail",
  pass: "must-pass",
  allowed: "allowed-exception",
} as const;

/**
 * What is wrong with a rule's cases: a required kind missing, a case of the wrong shape, a
 * must-fail case it doesn't report, or a must-pass or allowed case it does.
 */
const caseProblems = (
  local: LocalRule,
  rule: Rule,
  allowed: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const id = `${LOCAL_PREFIX}${local.id}`;
  const cases: unknown = local.cases;
  const why = {
    fail: "source with the bug, so a rule that stops catching it fails here",
    pass: "valid code close to the bug, so a rule that fires on valid code fails here before it fails a real file",
  };
  if (typeof cases !== "object" || cases === null)
    return [
      `${id} has no \`cases\`: give it \`cases: { fail: [...], pass: [...] }\` (${why.fail}; ${why.pass})`,
    ];
  const out: Array<string> = [];
  for (const kind of ["fail", "pass", "allowed"] as const) {
    const list: unknown = (cases as Record<string, unknown>)[kind];
    if (list === undefined && kind === "allowed") continue;
    if (!Array.isArray(list) || (kind !== "allowed" && list.length === 0)) {
      out.push(
        `${id} has no ${KINDS[kind]} case: add \`cases.${kind}\`, ${kind === "allowed" ? "a list of sources" : why[kind]}`,
      );
      continue;
    }
    list.forEach((entry: unknown, index) => {
      const at = `${id}'s ${KINDS[kind]} case ${index + 1}`;
      const { path, source } =
        typeof entry === "string"
          ? { path: CASE_PATH, source: entry }
          : typeof entry === "object" && entry !== null
            ? (entry as { path?: unknown; source?: unknown })
            : {};
      if (typeof path !== "string" || typeof source !== "string") {
        out.push(`${at} is neither source text nor \`{ path, source }\``);
        return;
      }
      const parsed = parse(path, source);
      const error = parsed.syntaxErrors[0];
      if (error !== undefined) {
        // Else a broken must-pass case passes, testing nothing, and a broken must-fail case
        // blames the rule.
        out.push(`${at} doesn't parse: ${error}; a case must be valid source`);
        return;
      }
      // As in a real run: a path the config allows reports nothing.
      const run = rule.run?.(parsed) ?? [];
      const allowedHere = matchesAny(path, allowed);
      if (kind === "fail" && allowedHere && !("broken" in run) && run.length > 0) {
        out.push(
          `${at} is at ${path}, which rules["${id}"].allow allows, so it can't fail; give the case another \`path\``,
        );
        return;
      }
      const found = "broken" in run || !allowedHere ? run : [];
      if ("broken" in found) out.push(`${at}: the rule broke on it: ${found.broken}`);
      else if (kind === "fail" && found.length === 0)
        out.push(`${at} reported nothing: the rule no longer catches the bug this case shows`);
      else if (kind !== "fail" && found.length > 0)
        out.push(
          `${at} was reported at line ${found.map((f) => lineAt(source, f.offset)).join(", ")}: the rule fires on code it must accept`,
        );
    });
  }
  return out;
};

export interface LocalRules {
  readonly rules: ReadonlyArray<Rule>;
  /**
   * By `local/<id>`: what is wrong with each valid rule's cases, run when the rule is on and
   * given the paths its config allows, which report nothing in a case as in a real run.
   */
  readonly cases: ReadonlyMap<string, (allowed: ReadonlyArray<string>) => ReadonlyArray<string>>;
  /** One reason per entry of `localRules` that isn't a usable rule, by its index. */
  readonly broken: ReadonlyArray<string>;
  /** The ids, as `local/<id>`, of broken entries whose id is valid: configuring them is fine. */
  readonly brokenIds: ReadonlyArray<string>;
}

/**
 * The config's `localRules`, validated. A misshaped entry or a repeated id is broken, with a
 * reason that says what the module must export; the valid ones still run.
 */
export const localRules = (entries: ReadonlyArray<unknown>): LocalRules => {
  const rules: Array<Rule> = [];
  const broken: Array<string> = [];
  const brokenIds: Array<string> = [];
  const cases = new Map<string, (allowed: ReadonlyArray<string>) => ReadonlyArray<string>>();
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    const reason = problem(entry);
    const at = `localRules[${index}]`;
    if (reason !== undefined) {
      broken.push(`${at} ${reason}: ${SHAPE}`);
      const id = (entry as { id?: unknown } | null)?.id;
      if (typeof id === "string" && ID.test(id)) brokenIds.push(`${LOCAL_PREFIX}${id}`);
      return;
    }
    const local = entry as LocalRule;
    if (seen.has(local.id)) {
      broken.push(`${at} repeats the id '${local.id}': give each local rule its own id`);
      return;
    }
    seen.add(local.id);
    const rule = toRule(local);
    rules.push(rule);
    cases.set(rule.id, (allowed) => caseProblems(local, rule, allowed));
  });
  return { rules, cases, broken, brokenIds };
};
