/**
 * A Python lexer just deep enough for the pack: the `#` comments, for `refs` and `shape-ignore`,
 * and the code with every string's and comment's text blanked, for the import scan. Strings
 * cover every prefix (`r`, `b`, `f`, `t`, `u` and their pairs), triple quotes, and f-strings'
 * replacement fields, whose own strings nest. Blanking keeps every offset and newline, so an
 * offset in `code` is one in the text: UTF-16, as every offset in the pack interface is.
 */
import type { Comment } from "../pack.ts";

export interface Lexed {
  readonly comments: ReadonlyArray<Comment>;
  /** The text with comments and string contents replaced by spaces, newlines kept. */
  readonly code: string;
}

const PREFIX = /^(?:[rRbBuUfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/;

const isIdentifierChar = (char: string | undefined): boolean =>
  char !== undefined && /[\p{L}\p{N}_]/u.test(char);

/** The prefix written just before `quote`, when it is one: `rb` in `rb"..."`. */
const prefixBefore = (text: string, quote: number): string => {
  let start = quote;
  while (start > 0 && start > quote - 2 && /[A-Za-z]/.test(text[start - 1] ?? "")) start--;
  const prefix = text.slice(start, quote);
  if (prefix === "" || !PREFIX.test(prefix) || isIdentifierChar(text[start - 1])) return "";
  return prefix;
};

export const lex = (text: string): Lexed => {
  const comments: Array<Comment> = [];
  const code = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to; i++) if (code[i] !== "\n" && code[i] !== "\r") code[i] = " ";
  };

  /**
   * Scans the string whose opening quote is at `start` and returns the offset after it. Its
   * contents are blanked; an f-string's replacement fields are scanned as code, so a string
   * inside one ends where Python ends it.
   */
  const string = (start: number, prefix: string): number => {
    const quote = text[start] ?? "";
    const triple = text.startsWith(quote.repeat(3), start);
    const close = triple ? quote.repeat(3) : quote;
    const raw = /[rR]/.test(prefix);
    const formatted = /[fFtT]/.test(prefix);
    let i = start + close.length;
    let blankFrom = i;
    while (i < text.length) {
      const char = text[i];
      if (char === "\\" && !raw) {
        i += 2;
        continue;
      }
      if (char === "\\" && raw) {
        // A raw string still can't end at an escaped quote.
        i += text[i + 1] === quote ? 2 : 1;
        continue;
      }
      if (!triple && char === "\n") {
        blank(blankFrom, i);
        return i;
      }
      if (text.startsWith(close, i)) {
        blank(blankFrom, i);
        return i + close.length;
      }
      if (formatted && char === "{") {
        if (text[i + 1] === "{") {
          i += 2;
          continue;
        }
        blank(blankFrom, i + 1);
        i = field(i + 1);
        blankFrom = i;
        continue;
      }
      i++;
    }
    blank(blankFrom, text.length);
    return text.length;
  };

  /** An f-string's replacement field from `start`, up to and past its closing `}`. */
  const field = (start: number): number => {
    let depth = 0;
    let i = start;
    while (i < text.length) {
      const char = text[i] ?? "";
      if (char === "'" || char === '"') {
        i = string(i, prefixBefore(text, i));
        continue;
      }
      if (char === "{" || char === "[" || char === "(") depth++;
      else if (char === ")" || char === "]") depth--;
      else if (char === "}") {
        if (depth === 0) return i + 1;
        depth--;
      } else if (char === ":" && depth === 0) {
        // The format spec: text, with nested fields of its own.
        const end = spec(i + 1);
        return end;
      }
      i++;
    }
    return text.length;
  };

  /** A format spec after `:` up to the field's `}`; `{...}` inside it is a nested field. */
  const spec = (start: number): number => {
    let i = start;
    while (i < text.length) {
      const char = text[i];
      if (char === "}") {
        blank(start, i);
        return i + 1;
      }
      if (char === "{") {
        blank(start, i + 1);
        i = field(i + 1);
        return spec(i);
      }
      i++;
    }
    return text.length;
  };

  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === "#") {
      let end = text.indexOf("\n", i);
      if (end === -1) end = text.length;
      if (text[end - 1] === "\r") end--;
      comments.push({ kind: "line", text: text.slice(i + 1, end), start: i, end });
      blank(i, end);
      i = end;
      continue;
    }
    if (char === "'" || char === '"') {
      i = string(i, prefixBefore(text, i));
      continue;
    }
    i++;
  }
  return { comments, code: code.join("") };
};
