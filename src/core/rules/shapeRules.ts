/**
 * Adopter rules in every language: `shape-rules/<id>.yml`, an ast-grep rule with
 * `metadata.bugClass`, and its cases in `shape-rules/<id>.test.yml` (`valid` and `invalid`
 * lists). The adapter runs them through ast-grep; this turns what it read into the engine's
 * rules, which report as `local/<id>` with the same scope, allowances and `shape-ignore` as
 * every rule, or into the problems that stop one from running.
 */
import type { ShapeRuleRun, ShapeRules } from "../model.ts";

/** Where a repo keeps its own rules. */
export const SHAPE_RULES_DIR = "shape-rules";

/** A rule file, as opposed to its cases file. */
export const isShapeRuleFile = (file: string): boolean =>
  new RegExp(`^${SHAPE_RULES_DIR}/[^/]+\\.ya?ml$`, "u").test(file) && !isCasesFile(file);

const isCasesFile = (file: string): boolean => /\.test\.ya?ml$/u.test(file);

/** A rule's cases file: `<id>.test.yml` beside `<id>.yml`. */
export const casesFileOf = (file: string): string => file.replace(/\.(ya?ml)$/u, ".test.$1");

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * The ast-grep languages whose files each pack claims, by the names ast-grep accepts, in
 * lower case. A rule in any other language would match only files outside the rules' scope.
 * TODO(monkeyshape-q0z): a pack says its own, once the engine runs packs' rules.
 */
const PACK_LANGUAGES: Readonly<Record<string, ReadonlyArray<string>>> = {
  typescript: ["typescript", "ts", "tsx"],
  rust: ["rust", "rs"],
  python: ["python", "py"],
};

/** A listed pack, as far as shape-rules care: its id and the language it reads. */
export interface ListedPack {
  readonly id: string;
  readonly language: string;
}

/** A rule ready for the engine: its matches by file, as 1-based lines. */
export interface ShapeRule {
  /** `local/<id>`. */
  readonly id: string;
  readonly file: string;
  readonly message: string;
  readonly bugClass: string;
  readonly lines: ReadonlyMap<string, ReadonlyArray<number>>;
}

/** What stops a rule or its cases, reported at `file` as `rules/<kind>`. */
export interface ShapeRuleProblem {
  readonly kind: "local-rule" | "local-cases";
  readonly file: string;
  readonly message: string;
}

export interface ShapeRuleSet {
  readonly rules: ReadonlyArray<ShapeRule>;
  readonly problems: ReadonlyArray<ShapeRuleProblem>;
  /** `local/<id>` of rules that didn't run: their allowances weren't tested, not unused. */
  readonly unrun: ReadonlyArray<string>;
}

const SHAPE = `a rule file is an ast-grep rule (\`id\`, \`language\`, \`rule\`, \`message\`) with \`metadata: { bugClass: "<the class of bug it removes>" }\`, named \`${SHAPE_RULES_DIR}/<id>.yml\` after its id`;

/** The file's own name, without `.yml`: what its id must be. */
const stem = (file: string): string => (file.split("/").at(-1) ?? file).replace(/\.ya?ml$/u, "");

/**
 * Why `run` can't be a rule, if it can't. A rule must be in a listed pack's language: the
 * rules run over files a listed pack claims, so any other rule would never report.
 */
const shapeProblem = (run: ShapeRuleRun, packs: ReadonlyArray<ListedPack>): string | undefined => {
  if (run.error !== undefined) return `does not run: ${run.error}`;
  if (run.id === undefined || !ID.test(run.id))
    return `has id ${JSON.stringify(run.id)}, not lowercase words joined by hyphens: ${SHAPE}`;
  if (run.id !== stem(run.file))
    return `has id '${run.id}' but is named ${stem(run.file)}.yml: rename the file to ${SHAPE_RULES_DIR}/${run.id}.yml, or the id to '${stem(run.file)}'`;
  for (const [key, text] of [
    ["message", run.message],
    ["metadata.bugClass", run.bugClass],
  ] as const)
    if (text === undefined || text.trim().length < 8)
      return `needs a \`${key}\` of at least 8 characters: ${SHAPE}`;
  const readable = packs.flatMap((pack) => PACK_LANGUAGES[pack.id] ?? []);
  if (!readable.includes((run.language ?? "").toLowerCase())) {
    const listed = packs.map((pack) => `${pack.id} reads ${pack.language}`).join(", ");
    return `has \`language: ${run.language ?? "(none)"}\`, which no listed pack reads (${listed || "no pack is listed"}): the rules run over the files a listed pack claims, so it would never report. Write it in ${readable.length === 0 ? "a listed pack's language" : `one of ${readable.join(", ")}`}, or check those files with a command in \`coverage.commands\``;
  }
  return undefined;
};

/** What is wrong with a valid rule's cases: missing lists, or a case it gets wrong. */
const caseProblems = (run: ShapeRuleRun, id: string): ReadonlyArray<ShapeRuleProblem> => {
  const casesFile = casesFileOf(run.file);
  const at = (message: string): ShapeRuleProblem => ({
    kind: "local-cases",
    file: run.cases.state === "absent" ? run.file : casesFile,
    message,
  });
  const lists =
    "`valid:` (code close to the bug, on which it must report nothing) and `invalid:` (code with the bug, which it must report), at least one each";
  if (run.cases.state === "absent")
    return [at(`${id} has no cases: add ${casesFile} with ${lists}`)];
  if (run.cases.state === "invalid")
    return [at(`${casesFile} is not a cases file (${run.cases.reason}): it holds ${lists}`)];
  const out: Array<ShapeRuleProblem> = [];
  for (const kind of ["invalid", "valid"] as const)
    if (!run.cases.runs.some((r) => r.kind === kind))
      out.push(
        at(
          `${id} has no ${kind} case: add one under \`${kind}:\` in ${casesFile}; it holds ${lists}`,
        ),
      );
  for (const r of run.cases.runs) {
    const name = `${id}'s ${r.kind} case ${r.index}`;
    if (r.error !== undefined) out.push(at(`${name} didn't run: ${r.error}`));
    else if (r.kind === "invalid" && r.matches === 0)
      out.push(at(`${name} reported nothing: the rule no longer catches the bug this case shows`));
    else if (r.kind === "valid" && r.matches > 0)
      out.push(
        at(
          `${name} was reported ${r.matches === 1 ? "once" : `${r.matches} times`}: the rule fires on code it must accept`,
        ),
      );
  }
  return out;
};

/**
 * The repo's shape-rules as engine rules, for the listed `packs`. `taken` are the ids already in use, by
 * `rules/<id>` as reported: a registry rule (`no-throw`) or a `localRules` one
 * (`local/no-save`). A rule whose id collides, or that is misshaped, doesn't run.
 */
export const shapeRuleSet = (
  shapeRules: ShapeRules | undefined,
  taken: ReadonlySet<string>,
  packs: ReadonlyArray<ListedPack>,
): ShapeRuleSet => {
  const rules: Array<ShapeRule> = [];
  const problems: Array<ShapeRuleProblem> = [];
  const unrun: Array<string> = [];
  const seen = new Set<string>();
  for (const run of shapeRules?.rules ?? []) {
    const problem = shapeProblem(run, packs);
    const id = `local/${run.id}`;
    if (problem !== undefined) {
      problems.push({ kind: "local-rule", file: run.file, message: problem });
      if (run.id !== undefined && ID.test(run.id)) unrun.push(id);
      continue;
    }
    const collides = [`${run.id}`, id].find((name) => taken.has(name) || seen.has(name));
    if (collides !== undefined) {
      problems.push({
        kind: "local-rule",
        file: run.file,
        message:
          collides === id
            ? `has id '${run.id}', which another local rule (in localRules or ${SHAPE_RULES_DIR}/) already has: rules/${id} would name both in configs and ignores. Rename this one`
            : `has id '${run.id}', which the core rule rules/${collides} has: rules/${id} and rules/${collides} would read as one rule. Rename this one`,
      });
      unrun.push(id);
      continue;
    }
    seen.add(id);
    problems.push(...caseProblems(run, id));
    const lines = new Map<string, Array<number>>();
    for (const match of run.matches)
      lines.set(match.file, [...(lines.get(match.file) ?? []), match.line]);
    rules.push({
      id,
      file: run.file,
      message: run.message ?? "",
      bugClass: run.bugClass ?? "",
      lines,
    });
  }
  return { rules, problems, unrun };
};
