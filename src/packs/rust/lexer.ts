/**
 * A Rust lexer that reads only what the pack needs: the tokens that make up items (to find
 * `mod` declarations) and the comments (for `refs` and `shape-ignore`). It skips strings, raw
 * strings, char literals and lifetimes so none of them is mistaken for either. Pure.
 */

export type Token =
  | { readonly kind: "ident"; readonly text: string; readonly offset: number }
  | { readonly kind: "string"; readonly text: string; readonly offset: number }
  | { readonly kind: "punct"; readonly text: string; readonly offset: number };

const isIdentStart = (c: string): boolean => /[\p{L}_]/u.test(c);
const isIdentPart = (c: string): boolean => /[\p{L}\p{N}_]/u.test(c);

/** Index after a raw string starting at `start` (at `r`), or undefined when it isn't one. */
const rawStringEnd = (text: string, start: number): { end: number; body: string } | undefined => {
  let i = start + 1;
  let hashes = 0;
  while (text[i] === "#") {
    hashes++;
    i++;
  }
  if (text[i] !== '"') return undefined;
  const close = `"${"#".repeat(hashes)}`;
  const end = text.indexOf(close, i + 1);
  if (end === -1) return { end: text.length, body: text.slice(i + 1) };
  return { end: end + close.length, body: text.slice(i + 1, end) };
};

/** One comment: a line comment, or a block comment, which nests in Rust. */
export interface Comment {
  readonly kind: "line" | "block";
  /** The text between the markers, as written. */
  readonly text: string;
  /** UTF-16 offsets of the comment's first character and the one after its last. */
  readonly start: number;
  readonly end: number;
}

/**
 * Tokens enough to find items (identifiers, string literals, punctuation) and the comments,
 * each in order. Offsets are UTF-16, as JS strings index.
 */
export const lex = (
  text: string,
): { readonly tokens: ReadonlyArray<Token>; readonly comments: ReadonlyArray<Comment> } => {
  const tokens: Array<Token> = [];
  const comments: Array<Comment> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const newline = text.indexOf("\n", i);
      const end = newline === -1 ? text.length : newline;
      comments.push({ kind: "line", text: text.slice(i + 2, end), start: i, end });
      i = end;
    } else if (c === "/" && next === "*") {
      // Block comments nest in Rust.
      let depth = 1;
      const start = i;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      comments.push({
        kind: "block",
        text: text.slice(start + 2, depth === 0 ? i - 2 : i),
        start,
        end: i,
      });
    } else if (
      (c === "r" && (next === '"' || next === "#")) ||
      (c === "b" && next === "r") ||
      (c === "c" && next === "r")
    ) {
      const raw = rawStringEnd(text, c === "r" ? i : i + 1);
      if (raw === undefined) {
        // `r#ident`: a raw identifier, read as the identifier itself.
        const start = c === "r" ? i + 2 : i;
        let end = start;
        while (end < text.length && isIdentPart(text[end] ?? "")) end++;
        if (end > start) tokens.push({ kind: "ident", text: text.slice(start, end), offset: i });
        i = Math.max(end, i + 1);
      } else {
        tokens.push({ kind: "string", text: raw.body, offset: i });
        i = raw.end;
      }
    } else if (c === '"' || ((c === "b" || c === "c") && next === '"')) {
      const start = c === '"' ? i : i + 1;
      let j = start + 1;
      let body = "";
      while (j < text.length && text[j] !== '"') {
        if (text[j] === "\\") {
          body += text[j + 1] ?? "";
          j += 2;
        } else {
          body += text[j];
          j++;
        }
      }
      tokens.push({ kind: "string", text: body, offset: i });
      i = j + 1;
    } else if (c === "'" || (c === "b" && next === "'")) {
      // A char literal (`'x'`, `'\n'`, `b'x'`) or a lifetime (`'a`), which has no closing quote.
      const start = c === "'" ? i : i + 1;
      if (text[start + 1] === "\\") {
        const close = text.indexOf("'", start + 3);
        i = close === -1 ? text.length : close + 1;
      } else {
        const codePoint = text.codePointAt(start + 1) ?? 0;
        const width = codePoint > 0xffff ? 2 : 1;
        if (text[start + 1 + width] === "'") i = start + 2 + width;
        else i = start + 1;
      }
    } else if (isIdentStart(c)) {
      let end = i + 1;
      while (end < text.length && isIdentPart(text[end] ?? "")) end++;
      tokens.push({ kind: "ident", text: text.slice(i, end), offset: i });
      i = end;
    } else if (/\s/.test(c)) i++;
    else {
      tokens.push({ kind: "punct", text: c, offset: i });
      i++;
    }
  }
  return { tokens, comments };
};
