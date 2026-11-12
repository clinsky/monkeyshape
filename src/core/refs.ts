/**
 * References in prose must resolve, and prose may only point at things a check keeps true.
 * Docs: backticked paths, `bun run` scripts, decision slugs and relative links must exist, and
 * each backticked span sits on one line, where it can be checked;
 * normative docs may not link into notes/, plan/ or handoffs. Plans and notes are held to form
 * only (`refs.formOnlyDocs`): one-line spans, no `§N`, no forbidden text, never whether a
 * path still exists. Code comments: no links into
 * those either, no `§N` citations, decision slugs must exist, bead ids only in `TODO(id)`.
 */
import { REFS_KINDS, type ResolvedConfig } from "../schemas/config.ts";
import { parseDecisions, SLUG } from "./decisions.ts";
import { matchesAny } from "./glob.ts";
import { fencedLines, splitCodeSpans } from "./markdown.ts";
import { isTsSource, lineAt, pathIndex, type Snapshot, type Violation } from "./model.ts";
import { parse } from "./parse.ts";
import { basename, dirname, join } from "./paths.ts";

/**
 * A specific note or handoff, or a section of the milestone plan or the roadmap. Naming the
 * directories or the files is fine: "the roadmap is `docs/roadmap.md`" points, it doesn't cite.
 */
const NON_NORMATIVE =
  /(^|[\s(`'"/])(?:\.{1,2}\/)*(?:(?:notes|\.handoffs)\/[\w.-]+|(?:plan\/[\w.-]+|docs\/roadmap\.md)#)/;
const SECTION_CITATION = /§\s*\d/;
const DECISION_REF = /\bD-[a-z0-9]+(?:-[a-z0-9]+)*\b/g;
const KNOWN_EXTENSION =
  /\.(ts|tsx|mts|cts|js|mjs|json|jsonc|jsonl|md|yaml|yml|toml|sh|txt|lock|grit|java|py)$/;

/** Every rule this check reports, as `refs/<kind>`; test/core/ruleCases.test.ts covers each. */
export const REFS_RULES = [...REFS_KINDS, "unused-allowance"] as const;

const violation = (
  rule: (typeof REFS_RULES)[number],
  file: string,
  line: number,
  message: string,
): Violation => ({
  check: "refs",
  rule: `refs/${rule}`,
  file,
  line,
  message,
});

/** Blanks fenced code blocks (keeping line numbers): examples there are not claims. */
export const stripFences = (text: string): string => {
  const lines = text.split("\n");
  const { fenced } = fencedLines(lines);
  return lines.map((line, i) => (fenced[i] ? "" : line)).join("\n");
};

/** Anything shaped like `prefix-id` or `prefix-id.3`; only ids beads actually knows count. */
const BEAD_CANDIDATE = /\b[a-z0-9]+(?:-[a-z0-9]+)*-[a-z0-9]+(?:\.[0-9]+)*\b/g;

/** Bare source file names are worth resolving; other bare names are usually runtime files or other packages' docs. */
const BARE_FILE = /^[\w.-]+\.(ts|tsx|mts|cts)$/;

/** Whether a backticked span reads as a repo path we can check, and the path to check. */
export const pathCandidate = (span: string): string | undefined => {
  const token = span.replace(/:\d+(:\d+)?$/, "");
  if (/\s/.test(token) || token.length < 3) return undefined;
  if (/^(https?:|mailto:|~|-|@|\$|<|node:|bun:)/.test(token)) return undefined;
  if (/[*?{}<>[\]()|=,;"'!]/.test(token) || token.includes("...")) return undefined;
  if (/^\.[\w.]+$/.test(token) || token.startsWith("node_modules/")) return undefined;
  if (!token.includes("/") && !BARE_FILE.test(token)) return undefined;
  return token.replace(/\/$/, "");
};

/**
 * `refs.rules`, as the rules engine applies `rules`: a kind turned off reports nothing, an
 * allowance silences its kind in the files it matches, and one that silences nothing is
 * reported so it doesn't outlive its reason, under `off` too, where it can never silence
 * anything. Only a kind whose running depends on the machine (`bead-in-code`, without bd or
 * its export) skips that: its allowance may be used where it runs.
 */
const applySettings = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  found: ReadonlyArray<Violation>,
): ReadonlyArray<Violation> => {
  const unrun = (kind: (typeof REFS_KINDS)[number]): boolean =>
    kind === "bead-in-code" && snapshot.beadIds === undefined;
  const settings = config.refs.rules;
  const used = new Set<string>();
  const kept = found.filter((v) => {
    const kind = REFS_KINDS.find((k) => v.rule === `refs/${k}`);
    const setting = kind === undefined ? undefined : settings[kind];
    if (setting?.off !== undefined) return false;
    const allowance = setting?.allow?.find((a) => matchesAny(v.file, [a.path]));
    if (allowance === undefined) return true;
    used.add(`${kind}\0${allowance.path}`);
    return false;
  });
  const unused = REFS_KINDS.flatMap((kind) =>
    unrun(kind)
      ? []
      : (settings[kind]?.allow ?? [])
          .filter((a) => !used.has(`${kind}\0${a.path}`))
          .map((a) =>
            violation(
              "unused-allowance",
              config.configFile,
              1,
              `refs.rules.${kind}.allow '${a.path}' allows nothing; delete it`,
            ),
          ),
  );
  return [...kept, ...unused];
};

const findRefs = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const index = pathIndex(snapshot.files);
  const files = new Set(snapshot.files);
  const basenames = new Set(snapshot.files.map(basename));
  const topLevel = new Set(snapshot.files.map((file) => file.split("/")[0] ?? ""));
  const decisions = new Set(
    parseDecisions(snapshot.texts.get("DECISIONS.md") ?? "").map((d) => d.slug),
  );
  const forbidden = config.refs.forbidden.map((f) => ({
    regex: new RegExp(f.pattern),
    reason: f.reason,
  }));
  const beads = snapshot.beadIds;

  /** Git lists a submodule as one entry; anything below it is the submodule's business. */
  const inSubmodule = (path: string): boolean => {
    const segments = path.split("/");
    return segments.some((_, i) => i > 0 && files.has(segments.slice(0, i).join("/")));
  };
  const pathExists = (doc: string, path: string): boolean => {
    const fromRoot = join(path);
    const fromDoc = join(dirname(doc), path);
    if (index.has(fromRoot) || index.has(fromDoc) || inSubmodule(fromRoot) || inSubmodule(fromDoc))
      return true;
    // A bare file name (`rules.ts`) refers to some file of that name.
    return !path.includes("/") && basenames.has(path);
  };
  /** Paths whose first segment isn't in the repo are probably package subpaths (`effect/Schema`). */
  const checkable = (path: string): boolean =>
    KNOWN_EXTENSION.test(path) || path.startsWith(".") || topLevel.has(path.split("/")[0] ?? "");

  const checkCommon = (file: string, line: number, text: string) => {
    if (SECTION_CITATION.test(text))
      violations.push(
        violation(
          "section-citation",
          file,
          line,
          "cites a `§N` section. Cite something a check keeps true: a path, a test or a D-slug.",
        ),
      );
    for (const { regex, reason } of forbidden)
      if (regex.test(text))
        violations.push(violation("forbidden", file, line, `matches /${regex.source}/: ${reason}`));
    for (const match of text.matchAll(DECISION_REF))
      if (SLUG.test(match[0]) && !decisions.has(match[0]))
        violations.push(
          violation(
            "unknown-decision",
            file,
            line,
            `'${match[0]}' is not an entry in DECISIONS.md`,
          ),
        );
  };

  for (const doc of snapshot.files) {
    if (!doc.endsWith(".md")) continue;
    const formOnly = matchesAny(doc, config.refs.formOnlyDocs);
    if (!formOnly && !matchesAny(doc, config.refs.docs)) continue;
    const text = snapshot.texts.get(doc);
    if (text === undefined) continue;
    const normative = !matchesAny(doc, config.refs.narrativeDocs);
    const lines = stripFences(text).split("\n");
    const split = splitCodeSpans(lines);
    lines.forEach((line, i) => {
      const n = i + 1;
      // Lines are read one at a time, so a span split across two is never checked.
      if (split.has(i))
        violations.push(
          violation(
            "split-code-span",
            doc,
            n,
            "a code span crosses a line break, so the refs check can't see it: keep each `...` span on one line.",
          ),
        );
      if (formOnly) {
        if (SECTION_CITATION.test(line))
          violations.push(
            violation(
              "section-citation",
              doc,
              n,
              "cites a `§N` section, which moves when the doc it points into is edited. Name the section or the file instead.",
            ),
          );
        // A forbidden pattern bans text, whatever exists: it holds in plans and notes too.
        for (const { regex, reason } of forbidden)
          if (regex.test(line))
            violations.push(violation("forbidden", doc, n, `matches /${regex.source}/: ${reason}`));
        return;
      }
      checkCommon(doc, n, line);
      if (
        normative &&
        NON_NORMATIVE.test(line.replace(/`[^`]*`/g, (span) => span.replaceAll("`", " ")))
      )
        violations.push(
          violation(
            "normative-link",
            doc,
            n,
            "a normative doc points into notes/, plan/ or a handoff, which age by design. Promote what matters into a check, test or decision.",
          ),
        );
      for (const match of line.matchAll(/`([^`\n]+)`/g)) {
        const span = match[1] ?? "";
        const script = /^bun run (?:--?[\w-]+ )*([\w:./-]+)/.exec(span)?.[1];
        // Flags such as `--silent` come before the script.
        // `bun run path/to/file.ts` runs a file, which the path check below covers.
        if (script !== undefined && !script.includes("/") && !KNOWN_EXTENSION.test(script)) {
          if (!snapshot.packageScripts.has(script))
            violations.push(
              violation(
                "unknown-script",
                doc,
                n,
                `\`bun run ${script}\` is not a package.json script`,
              ),
            );
          continue;
        }
        const path = pathCandidate(span.replace(/^bun (run )?/, ""));
        if (path !== undefined && checkable(path) && !pathExists(doc, path))
          violations.push(
            violation(
              "missing-path",
              doc,
              n,
              `\`${span}\` does not exist in the repo. Fix the path; or, if it is relative to a directory created at run time, name that directory with a placeholder (\`<workdir>/${path}\`), which refs doesn't resolve.`,
            ),
          );
      }
      for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = (match[1] ?? "").split("#")[0] ?? "";
        if (target === "" || /^[a-z]+:/.test(target)) continue;
        if (!pathExists(doc, target))
          violations.push(
            violation(
              "missing-path",
              doc,
              n,
              `link target '${target}' does not exist in the repo. Fix the link, or unlink a path that only exists at run time.`,
            ),
          );
      }
    });
  }

  for (const file of snapshot.files) {
    if (!isTsSource(file)) continue;
    const text = snapshot.texts.get(file);
    if (text === undefined) continue;
    for (const comment of parse(file, text).comments) {
      const line = lineAt(text, comment.start);
      checkCommon(file, line, comment.value);
      if (NON_NORMATIVE.test(comment.value))
        violations.push(
          violation(
            "normative-link",
            file,
            line,
            "code points into notes/, plan/ or a handoff, which age by design. State the reason here, or cite a test or D-slug.",
          ),
        );
      if (beads !== undefined)
        for (const match of comment.value.matchAll(BEAD_CANDIDATE)) {
          if (!beads.has(match[0])) continue;
          const before = comment.value.slice(0, match.index).trimEnd();
          if (!before.endsWith("TODO("))
            violations.push(
              violation(
                "bead-in-code",
                file,
                line,
                `cites bead '${match[0]}'. Beads change and close; only \`TODO(${match[0]})\` may name one.`,
              ),
            );
        }
    }
  }
  return violations;
};

export const checkRefs = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> =>
  applySettings(config, snapshot, findRefs(config, snapshot));
