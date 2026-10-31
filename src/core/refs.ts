/**
 * References in prose must resolve, and prose may only point at things a check keeps true.
 * Docs: backticked paths, `bun run` scripts, decision slugs and relative links must exist, and
 * each backticked span sits on one line, where it can be checked;
 * normative docs may not link into notes/, plan/ or handoffs. Code comments: no links into
 * those either, no `§N` citations, decision slugs must exist, bead ids only in `TODO(id)`.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { parseDecisions, SLUG } from "./decisions.ts";
import { matchesAny } from "./glob.ts";
import { fencedLines, opensCodeSpan } from "./markdown.ts";
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

const violation = (rule: string, file: string, line: number, message: string): Violation => ({
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

export const checkRefs = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
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
    if (!doc.endsWith(".md") || !matchesAny(doc, config.refs.docs)) continue;
    const text = snapshot.texts.get(doc);
    if (text === undefined) continue;
    const normative = !matchesAny(doc, config.refs.narrativeDocs);
    const { indentedCode } = fencedLines(text.split("\n"));
    stripFences(text)
      .split("\n")
      .forEach((line, i) => {
        const n = i + 1;
        checkCommon(doc, n, line);
        // Lines are read one at a time, so a span split across two is never checked. In
        // indented code a backtick is literal.
        if (!indentedCode[i] && opensCodeSpan(line))
          violations.push(
            violation(
              "split-code-span",
              doc,
              n,
              "a code span crosses a line break, so the refs check can't see it: keep each `...` span on one line.",
            ),
          );
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
          const script = /^bun run ([\w:./-]+)/.exec(span)?.[1];
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
            violations.push(violation("missing-path", doc, n, `\`${span}\` does not exist`));
        }
        for (const match of line.matchAll(/\]\(([^)\s]+)\)/g)) {
          const target = (match[1] ?? "").split("#")[0] ?? "";
          if (target === "" || /^[a-z]+:/.test(target)) continue;
          if (!pathExists(doc, target))
            violations.push(
              violation("missing-path", doc, n, `link target '${target}' does not exist`),
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
