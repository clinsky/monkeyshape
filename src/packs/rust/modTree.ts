/**
 * The files a crate compiles: every file reached from a target's root through `mod`
 * declarations, resolved as rustc resolves them (`foo.rs` or `foo/mod.rs`, a non-`mod.rs`
 * file's children in its own directory, inline `mod a { mod b; }` blocks, `#[path = "..."]`).
 * rustc, clippy and rustfmt all see this set, so a `.rs` file outside it is checked by none
 * of them. Pure: it reads the texts it is given. A `mod` that a macro expands to isn't seen.
 */
import { basename, dirname, join } from "../../core/paths.ts";
import { lex, type Token } from "./lexer.ts";

/** One `mod` item declared out of line, with the path a `#[path]` attribute gave it. */
export interface ModDeclaration {
  readonly name: string;
  /** Inline `mod` blocks enclosing it, outermost first. */
  readonly inline: ReadonlyArray<string>;
  readonly path: string | undefined;
  readonly offset: number;
}

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
  const tokens = lex(text).tokens;
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
