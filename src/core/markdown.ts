/**
 * The Markdown structure the checks need, as CommonMark defines it: fenced code blocks and code
 * spans. Both the refs check and the handoff parser read fences from here, so they can't
 * disagree about where a block ends.
 */

/** A list item's marker and the space after it: the item's content starts where this ends. */
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

const QUOTE = /^ {0,3}>[ \t]?/;

/** A line without its blockquote markers, and how many it had. */
const unquote = (line: string): { readonly depth: number; readonly text: string } => {
  let depth = 0;
  let text = line;
  for (let m = QUOTE.exec(text); m !== null; m = QUOTE.exec(text)) {
    depth++;
    text = text.slice(m[0].length);
  }
  return { depth, text };
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * A line's leading container markers, quotes and list items nested in any order (`1. - `,
 * `- > `): how many quotes, the text after them all, whether a list item opens here, and
 * where its content starts, measured after the last quote.
 */
const containers = (
  line: string,
): {
  readonly depth: number;
  readonly text: string;
  readonly item: boolean;
  readonly content: number;
} => {
  let depth = 0;
  let text = line;
  let item = false;
  let content = 0;
  for (;;) {
    const quote = QUOTE.exec(text);
    const list = quote === null ? LIST_ITEM.exec(text) : null;
    if (quote !== null) {
      depth++;
      content = 0;
      item = false;
      text = text.slice(quote[0].length);
    } else if (list !== null) {
      item = true;
      content += list[0].length;
      text = text.slice(list[0].length);
    } else return { depth, text, item, content };
  }
};

/**
 * For each line, whether it belongs to a fenced code block, fence lines included; and the line
 * of a fence still open at the end. A fence opens with at least three backticks or tildes (a
 * backtick fence's info string has no backtick), and closes only on the same character, at
 * least as long, with nothing after it. Both fences may be indented at most three spaces past
 * the content of the list item they sit in, as in CommonMark: four spaces at the top level is
 * an indented code block, but five inside a nested item is still a fence. A fence may open
 * after container markers on its own line (`- `, `1. - `, `- > `), and inside a blockquote; it
 * closes when its blockquote does. HTML blocks aren't modelled: a fence-shaped line inside one
 * is read as a fence, which leaves it unchecked rather than failing. test/core/markdownReference.test.ts holds this to a reference parser.
 */
export const fencedLines = (
  lines: ReadonlyArray<string>,
): { readonly fenced: ReadonlyArray<boolean>; readonly unclosed: number | undefined } => {
  const fenced: Array<boolean> = [];
  let open:
    | {
        readonly marker: string;
        readonly line: number;
        readonly depth: number;
        readonly content: number;
      }
    | undefined;
  // Where the enclosing list item's content starts; 0 outside a list. Approximate: a line
  // indented less than that is taken to have left the item.
  let content = 0;
  lines.forEach((raw, index) => {
    const { depth, text: line } = unquote(raw);
    // Fenced code can't continue lazily: when its blockquote ends, so does the fence.
    if (open !== undefined && depth < open.depth) open = undefined;
    if (open === undefined) {
      const opening = containers(raw);
      const indent = indentOf(opening.text);
      const fence = FENCE.exec(opening.text);
      const marker = fence?.[2];
      const opens =
        marker !== undefined &&
        (opening.item || indent - Math.min(content, indent) <= 3) &&
        !(marker.startsWith("`") && (fence?.[3] ?? "").includes("`"));
      if (raw.trim() !== "") content = opening.item ? opening.content : Math.min(content, indent);
      if (opens) open = { marker, line: index, depth: opening.depth, content };
      fenced.push(opens);
      return;
    }
    fenced.push(true);
    const fence = FENCE.exec(line);
    const marker = fence?.[2];
    const indent = indentOf(line);
    if (
      marker !== undefined &&
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      (fence?.[3] ?? "").trim() === "" &&
      indent - Math.min(open.content, indent) <= 3
    )
      open = undefined;
  });
  return { fenced, unclosed: open?.line };
};

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

/**
 * CommonMark's HTML block starts, each with what ends it (`undefined`: a blank line), and
 * whether it may interrupt a paragraph. Inside an HTML block a backtick is literal.
 */
const HTML_BLOCKS: ReadonlyArray<{
  readonly start: RegExp;
  readonly end: RegExp | undefined;
  readonly interrupts: boolean;
}> = [
  {
    start: /^ {0,3}<(?:script|pre|style|textarea)(?:\s|>|$)/i,
    end: /<\/(?:script|pre|style|textarea)>/i,
    interrupts: true,
  },
  { start: /^ {0,3}<!--/, end: /-->/, interrupts: true },
  { start: /^ {0,3}<\?/, end: /\?>/, interrupts: true },
  { start: /^ {0,3}<![A-Za-z]/, end: />/, interrupts: true },
  { start: /^ {0,3}<!\[CDATA\[/, end: /\]\]>/, interrupts: true },
  {
    start: new RegExp(`^ {0,3}</?(?:${BLOCK_TAGS})(?:\\s|/?>|$)`, "i"),
    end: undefined,
    interrupts: true,
  },
  {
    start:
      /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/,
    end: undefined,
    interrupts: false,
  },
];

/**
 * A whole-line link reference definition, `[x]: /url "title"`, which is not a paragraph. Only
 * the whole line counts: `[Note]: a b c` has text after its destination that isn't a title, so
 * it is a paragraph. A title continued on the next line isn't matched, which is a miss.
 */
const LINK_DEFINITION =
  /^ {0,3}\[(?:[^\]\\]|\\.)+\]:\s*(?:<[^>]*>|\S+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*$/;

/** A line that starts a new block, so a code span can't continue onto it from the line above. */
const BLOCK_START = /^ {0,3}(?:[-*+]\s|\d{1,9}[.)]\s|#{1,6}(?:\s|$)|>)/;
/** A setext underline or thematic break: it ends the paragraph above it. */
const UNDERLINE = /^ {0,3}(?:=+|-+|(?:[-*_][ \t]*){3,})[ \t]*$/;

/**
 * The lines (0-based) on which a code span opens and continues onto the next line, as
 * CommonMark pairs backticks: within one paragraph, a run of n backticks closes at the next
 * run of exactly n, and a run with no partner is literal text. A backslash escapes a backtick
 * outside a span; HTML blocks, HTML comments and link definitions hold none. Pass lines with
 * fenced code already blanked.
 * test/core/markdownReference.test.ts holds this to a reference parser.
 */
export const splitCodeSpans = (lines: ReadonlyArray<string>): ReadonlySet<number> => {
  const split = new Set<number>();
  let block: Array<number> = [];
  const flush = () => {
    const starts: Array<number> = [];
    let text = "";
    for (const index of block) {
      starts.push(text.length);
      text += `${unquote(lines[index] ?? "").text.replace(/<!--.*?-->/g, "")}\n`;
    }
    const lineAt = (offset: number) => {
      let k = 0;
      while (k + 1 < starts.length && (starts[k + 1] ?? 0) <= offset) k++;
      return block[k] ?? 0;
    };
    const runLength = (at: number) => {
      let end = at;
      while (text[end] === "`") end++;
      return end - at;
    };
    let i = 0;
    while (i < text.length) {
      if (text[i] === "\\") i += 2;
      else if (text[i] !== "`") i++;
      else {
        const n = runLength(i);
        let j = i + n;
        let close: number | undefined;
        while (j < text.length && close === undefined) {
          if (text[j] !== "`") j++;
          else {
            const m = runLength(j);
            if (m === n) close = j;
            j += m;
          }
        }
        if (close === undefined) i += n;
        else {
          if (text.slice(i, close).includes("\n")) split.add(lineAt(i));
          i = close + n;
        }
      }
    }
    block = [];
  };
  // The end of the HTML block being skipped: a pattern, or a blank line when `null`.
  let html: RegExp | null | undefined;
  lines.forEach((raw, index) => {
    const line = unquote(raw).text;
    const quoted = raw !== line;
    if (html !== undefined) {
      if (html === null ? line.trim() === "" : html.test(line)) html = undefined;
      return;
    }
    if (line.trim() === "" || UNDERLINE.test(line)) {
      flush();
      return;
    }
    const startsHtml = HTML_BLOCKS.find(
      (kind) => kind.start.test(line) && (kind.interrupts || block.length === 0),
    );
    if (startsHtml !== undefined) {
      flush();
      // A block whose end is on its first line ends there.
      if (startsHtml.end === undefined) html = null;
      else if (!startsHtml.end.test(line.replace(startsHtml.start, ""))) html = startsHtml.end;
      return;
    }
    // An indented line can't start a paragraph: it is indented code, where backticks are literal.
    // Nor is a link definition one, and it can't interrupt one.
    if (block.length === 0 && (/^( {4}|\t)/.test(line) || LINK_DEFINITION.test(line))) return;
    const previous = block.at(-1);
    if (
      block.length > 0 &&
      (BLOCK_START.test(line) ||
        (previous !== undefined && quoted !== (lines[previous] ?? "").trimStart().startsWith(">")))
    )
      flush();
    block.push(index);
    if (/^ {0,3}#{1,6}(?:\s|$)/.test(line)) flush();
  });
  flush();
  return split;
};
