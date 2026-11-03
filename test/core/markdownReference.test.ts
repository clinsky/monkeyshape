/**
 * The Markdown the checks read, held to a reference CommonMark parser (micromark, through
 * mdast-util-from-markdown; dev dependencies used only here) over every example in the
 * CommonMark spec and the inputs that broke the refs check before (#18, #26's review). The direction that
 * matters is valid input failing a check: code the reference sees in a fence must not be
 * read as prose, and a split code span must be one the reference sees cross a line break.
 */
import { describe, expect, test } from "bun:test";
import { tests as SPEC } from "commonmark-spec";
import { fromMarkdown } from "mdast-util-from-markdown";
import { fencedLines, splitCodeSpans } from "../../src/core/markdown.ts";
import { checkRefs, stripFences } from "../../src/core/refs.ts";
import { config, repo } from "../support.ts";

/** Valid Markdown the refs check once failed: odd backticks, fences in lists, indented code. */
const REGRESSIONS: Readonly<Record<string, string>> = {
  doubleSpan: "Start a span with `` ` `` and close it.\n",
  escaped: "A lone \\` is literal in Markdown.\n",
  lone: "A lone ` is literal too, and so is `` this.\n",
  longFence: "````md\n```bash\necho `date\n```\n````\n",
  tildeFence: "~~~\n```\nodd ` here\n~~~\n",
  comment: "<!-- don't ` -->\n",
  nested: "``a ` b`` and `c`\n",
  listFence:
    "1. Install:\n   - then run:\n\n     ```sh\n     cat scripts/setup.sh `# a comment`\n     echo `date\n     ```\n",
  fenceOnMarker: "- ```sh\n  echo `date\n  ```\n- next\n",
  quotedFence: "> ```\n> echo `date\n> ```\n",
  indentedCode: "Text\n\n    echo `date\n",
  tabCode: "Text\n\n\techo `date\n",
  spanAcrossLines: "Run `bun run\ncheck` first, then `a`.\n",
  // From #26's review: container markers stacked on a fence's line, HTML blocks, link titles.
  fenceAfterTwoItems: "- - ```sh\n    echo `scripts/\n    other` x\n    ```\n",
  fenceInOrderedNested: "1. - ```sh\n     echo `scripts/nope.sh`\n     ```\n",
  fenceInQuoteInItem: "- > ```sh\n  > echo `scripts/nope.sh`\n  > ```\n",
  htmlBlock: "<details>\nrun `scripts/\nnope.sh` here\n</details>\n",
  htmlInterrupts: "Use a lone ` here\n<details>\n<summary>`x</summary>\n",
  linkTitle: '[x]: /url "a `b"\nc` d\n',
};

const EXAMPLES: ReadonlyArray<{ readonly name: string; readonly markdown: string }> = [
  ...SPEC.map((example) => ({
    name: `spec #${example.number} (${example.section})`,
    // The spec writes tabs as arrows so they show.
    markdown: example.markdown.replaceAll("→", "\t"),
  })),
  ...Object.entries(REGRESSIONS).map(([name, markdown]) => ({ name, markdown })),
];

interface Node {
  readonly type: string;
  readonly position?: {
    readonly start: { readonly line: number; readonly offset?: number };
    readonly end: { readonly line: number };
  };
  readonly children?: ReadonlyArray<Node>;
}

const walk = (node: Node, visit: (node: Node) => void): void => {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

/** What the reference sees: lines (1-based) in fenced code, and the lines code spans cross. */
const reference = (markdown: string) => {
  const fenced = new Set<number>();
  const spans: Array<{ readonly start: number; readonly end: number }> = [];
  walk(fromMarkdown(markdown) as Node, (node) => {
    const at = node.position;
    if (at === undefined) return;
    // mdast has one `code` node for fenced and indented code; a fenced one starts at its fence.
    if (node.type === "code" && /^[`~]{3}/.test(markdown.slice(at.start.offset ?? 0)))
      for (let line = at.start.line; line <= at.end.line; line++) fenced.add(line);
    if (node.type === "inlineCode" && at.end.line > at.start.line)
      spans.push({ start: at.start.line, end: at.end.line });
  });
  return { fenced, spans };
};

/** Example names mapped to the lines where `differs` holds, for examples with any. */
const disagreements = (
  differs: (markdown: string) => ReadonlyArray<number>,
): Readonly<Record<string, ReadonlyArray<number>>> =>
  Object.fromEntries(
    EXAMPLES.map(({ name, markdown }) => [name, differs(markdown)] as const).filter(
      ([, lines]) => lines.length > 0,
    ),
  );

/** Blank lines carry no claims, so whether one counts as fenced doesn't matter. */
const nonBlank = (markdown: string): ReadonlyArray<number> =>
  markdown.split("\n").flatMap((line, i) => (line.trim() === "" ? [] : [i + 1]));

const splitLines = (markdown: string): ReadonlyArray<number> =>
  checkRefs(config(), repo({ "AGENTS.md": markdown }))
    .filter((v) => v.rule === "refs/split-code-span")
    .map((v) => v.line ?? 0);

describe("the Markdown the checks read agrees with a reference CommonMark parser", () => {
  test("the examples are there: every spec example, and the regressions", () => {
    expect(SPEC.length).toBeGreaterThan(600);
  });

  test("code the reference sees in a fence is never read as prose", () => {
    expect(
      disagreements((markdown) => {
        const { fenced } = fencedLines(markdown.split("\n"));
        const { fenced: expected } = reference(markdown);
        return nonBlank(markdown).filter((line) => expected.has(line) && !fenced[line - 1]);
      }),
    ).toEqual({});
  });

  test("prose read as fenced code, which goes unchecked: only where an HTML block swallows a fence", () => {
    // The refs check doesn't model HTML blocks; skipping a fence-shaped line inside one only
    // leaves it unchecked, it never fails valid input.
    expect(
      disagreements((markdown) => {
        const { fenced } = fencedLines(markdown.split("\n"));
        const { fenced: expected } = reference(markdown);
        return nonBlank(markdown).filter((line) => fenced[line - 1] && !expected.has(line));
      }),
    ).toEqual({ "spec #161 (HTML blocks)": [2, 3, 4] });
  });

  test("refs/split-code-span fires only where the reference sees a span cross a line break", () => {
    expect(
      disagreements((markdown) => {
        const { spans } = reference(markdown);
        return splitLines(markdown).filter(
          (line) => !spans.some((span) => span.start <= line && line < span.end),
        );
      }),
    ).toEqual({});
  });

  test("and it fires on every span the reference sees cross a line break outside a fence", () => {
    expect(
      disagreements((markdown) => {
        const { spans } = reference(markdown);
        const found = splitCodeSpans(stripFences(markdown).split("\n"));
        return spans.filter((span) => !found.has(span.start - 1)).map((span) => span.start);
      }),
    ).toEqual({});
  });
});
