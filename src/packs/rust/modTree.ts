/**
 * The files a crate compiles: every file reached from a target's root through `mod`
 * declarations, resolved as rustc resolves them (`foo.rs` or `foo/mod.rs`, a non-`mod.rs`
 * file's children in its own directory, inline `mod a { mod b; }` blocks, `#[path = "..."]`).
 * rustc, clippy and rustfmt all see this set, so a `.rs` file outside it is checked by none
 * of them. Pure: it reads the texts it is given. A `mod` that a macro expands to isn't seen.
 */
import { basename, dirname, join } from "../../core/paths.ts";

/** One `mod` item declared out of line, with the path a `#[path]` attribute gave it. */
export interface ModDeclaration {
  readonly name: string;
  /** Inline `mod` blocks enclosing it, outermost first. */
  readonly inline: ReadonlyArray<string>;
  readonly path: string | undefined;
  readonly offset: number;
}

type Token =
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

/** Tokens enough to find items: identifiers, string literals, punctuation; comments dropped. */
export const tokenize = (text: string): ReadonlyArray<Token> => {
  const tokens: Array<Token> = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    } else if (c === "/" && next === "*") {
      // Block comments nest in Rust.
      let depth = 1;
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
  return tokens;
};

/** The value of a `#[path = "..."]` attribute whose `[` is at `open`, and the index after `]`. */
const attribute = (
  tokens: ReadonlyArray<Token>,
  open: number,
): { path: string | undefined; end: number } => {
  let depth = 0;
  let i = open;
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (token?.kind !== "punct") continue;
    if (token.text === "[") depth++;
    else if (token.text === "]") {
      depth--;
      if (depth === 0) break;
    }
  }
  const a = tokens[open + 1];
  const b = tokens[open + 2];
  const c = tokens[open + 3];
  const isPath =
    a?.kind === "ident" &&
    a.text === "path" &&
    b?.kind === "punct" &&
    b.text === "=" &&
    c?.kind === "string" &&
    i === open + 4;
  return { path: isPath ? c.text : undefined, end: i + 1 };
};

/** Every out-of-line `mod name;` in a file, with its enclosing inline modules. */
export const modDeclarations = (text: string): ReadonlyArray<ModDeclaration> => {
  const tokens = tokenize(text);
  const found: Array<ModDeclaration> = [];
  // Inline modules open, each with the brace depth inside it.
  const inline: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  let pendingPath: string | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "punct" && token.text === "#") {
      const bang = tokens[i + 1]?.text === "!" ? 1 : 0;
      if (tokens[i + 1 + bang]?.text === "[") {
        const attr = attribute(tokens, i + 1 + bang);
        if (bang === 0 && attr.path !== undefined) pendingPath = attr.path;
        i = attr.end - 1;
        continue;
      }
    }
    if (token.kind === "punct") {
      if (token.text === "{") depth++;
      else if (token.text === "}") {
        depth--;
        if (inline.length > 0 && inline[inline.length - 1]?.depth === depth + 1) inline.pop();
      }
      if (token.text === ";" || token.text === "{" || token.text === "}") pendingPath = undefined;
      continue;
    }
    if (token.kind !== "ident" || token.text !== "mod") continue;
    const name = tokens[i + 1];
    const after = tokens[i + 2];
    if (name?.kind !== "ident" || after?.kind !== "punct") continue;
    if (after.text === ";") {
      found.push({
        name: name.text,
        inline: inline.map((open) => open.name),
        path: pendingPath,
        offset: token.offset,
      });
      pendingPath = undefined;
      i += 2;
    } else if (after.text === "{") {
      depth++;
      inline.push({ name: name.text, depth });
      pendingPath = undefined;
      i += 2;
    }
  }
  return found;
};

/**
 * The files a declaration may name, in rustc's order. `ownsDirectory` is true for a crate
 * root and a `mod.rs`, whose children sit beside it; any other `foo.rs` keeps its children
 * in `foo/`.
 */
export const candidates = (
  file: string,
  ownsDirectory: boolean,
  declaration: ModDeclaration,
): ReadonlyArray<string> => {
  const directory = dirname(file);
  const own = ownsDirectory ? directory : join(directory, basename(file).replace(/\.rs$/, ""));
  if (declaration.path !== undefined)
    return [
      declaration.inline.length === 0
        ? join(directory, declaration.path)
        : join(own, ...declaration.inline, declaration.path),
    ];
  const base = join(own, ...declaration.inline, declaration.name);
  return [`${base}.rs`, `${base}/mod.rs`];
};

/**
 * The files reached from `roots`, each a crate target's root file, through the `mod` tree.
 * `texts` holds every `.rs` file's text by repo-relative path; a declaration whose file is
 * missing is rustc's error to report, and is skipped here.
 */
export const reachedFiles = (
  roots: ReadonlyArray<string>,
  texts: ReadonlyMap<string, string>,
): ReadonlySet<string> => {
  const reached = new Set<string>();
  const queue: Array<{ file: string; ownsDirectory: boolean }> = roots.map((file) => ({
    file,
    ownsDirectory: true,
  }));
  while (queue.length > 0) {
    const item = queue.pop();
    if (item === undefined || reached.has(item.file)) continue;
    const text = texts.get(item.file);
    if (text === undefined) continue;
    reached.add(item.file);
    for (const declaration of modDeclarations(text)) {
      const file = candidates(item.file, item.ownsDirectory, declaration).find((candidate) =>
        texts.has(candidate),
      );
      if (file !== undefined)
        queue.push({
          file,
          ownsDirectory: declaration.path !== undefined || basename(file) === "mod.rs",
        });
    }
  }
  return reached;
};
