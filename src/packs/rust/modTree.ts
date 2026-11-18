/**
 * The files a crate compiles: every file reached from a target's root through `mod`
 * declarations and `include!`, resolved as rustc resolves them (`foo.rs` or `foo/mod.rs`, a
 * non-`mod.rs` file's children in its own directory, inline `mod a { mod b; }` blocks,
 * `#[path = "..."]` on a declaration or a block, and `path` inside `cfg_attr`, each
 * platform's file counting). rustc, clippy and rustfmt all see this set, so a `.rs` file
 * outside it is checked by none of them. Pure: it reads the texts it is given. Not seen: a
 * `mod` or `include!` that a macro expands to, and an `include!` of a computed path.
 */
import { basename, dirname, join } from "../../core/paths.ts";
import { lex, type Token } from "./lexer.ts";

/** An enclosing inline `mod` block, with the `#[path]` it carries. */
export interface InlineBlock {
  readonly name: string;
  readonly path: string | undefined;
}

/** One `mod` item declared out of line, with the paths its attributes give it. */
export interface ModDeclaration {
  readonly name: string;
  /** Inline `mod` blocks enclosing it, outermost first. */
  readonly inline: ReadonlyArray<InlineBlock>;
  /** `#[path = "..."]`: the one file, on every platform. */
  readonly path: string | undefined;
  /** `#[cfg_attr(<cfg>, path = "...")]`: a file each, on the platforms whose cfg holds. */
  readonly cfgPaths: ReadonlyArray<string>;
  readonly offset: number;
}

/** What an attribute whose `[` is at `open` says of a path, and the index after its `]`. */
const attribute = (
  tokens: ReadonlyArray<Token>,
  open: number,
): { path: string | undefined; cfgPaths: ReadonlyArray<string>; end: number } => {
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
  const pathAt = (at: number): string | undefined => {
    const [a, b, c] = [tokens[at], tokens[at + 1], tokens[at + 2]];
    return a?.kind === "ident" &&
      a.text === "path" &&
      b?.kind === "punct" &&
      b.text === "=" &&
      c?.kind === "string"
      ? c.text
      : undefined;
  };
  const first = tokens[open + 1];
  const plain = pathAt(open + 1);
  if (plain !== undefined && i === open + 4) return { path: plain, cfgPaths: [], end: i + 1 };
  const cfgPaths: Array<string> = [];
  if (first?.kind === "ident" && first.text === "cfg_attr")
    for (let at = open + 2; at < i; at++) {
      const found = pathAt(at);
      if (found !== undefined) cfgPaths.push(found);
    }
  return { path: undefined, cfgPaths, end: i + 1 };
};

/** Every out-of-line `mod name;` in a file, with its enclosing inline modules. */
export const modDeclarations = (text: string): ReadonlyArray<ModDeclaration> => {
  const tokens = lex(text).tokens;
  const found: Array<ModDeclaration> = [];
  // Inline modules open, each with the brace depth inside it.
  const inline: Array<InlineBlock & { depth: number }> = [];
  let depth = 0;
  let pendingPath: string | undefined;
  let pendingCfgPaths: Array<string> = [];
  const clear = () => {
    pendingPath = undefined;
    pendingCfgPaths = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined) continue;
    if (token.kind === "punct" && token.text === "#") {
      const bang = tokens[i + 1]?.text === "!" ? 1 : 0;
      if (tokens[i + 1 + bang]?.text === "[") {
        const attr = attribute(tokens, i + 1 + bang);
        if (bang === 0) {
          if (attr.path !== undefined) pendingPath = attr.path;
          pendingCfgPaths.push(...attr.cfgPaths);
        }
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
      if (token.text === ";" || token.text === "{" || token.text === "}") clear();
      continue;
    }
    if (token.kind !== "ident" || token.text !== "mod") continue;
    const name = tokens[i + 1];
    const after = tokens[i + 2];
    if (name?.kind !== "ident" || after?.kind !== "punct") continue;
    if (after.text === ";") {
      found.push({
        name: name.text,
        inline: inline.map((open) => ({ name: open.name, path: open.path })),
        path: pendingPath,
        cfgPaths: pendingCfgPaths,
        offset: token.offset,
      });
      clear();
      i += 2;
    } else if (after.text === "{") {
      depth++;
      inline.push({ name: name.text, path: pendingPath, depth });
      clear();
      i += 2;
    }
  }
  return found;
};

/** Each `include!("<literal>")` in a file: rustc reads it relative to that file's directory. */
export const includes = (text: string): ReadonlyArray<string> => {
  const tokens = lex(text).tokens;
  const found: Array<string> = [];
  for (let i = 0; i + 4 < tokens.length; i++) {
    const [a, b, c, d, e] = [tokens[i], tokens[i + 1], tokens[i + 2], tokens[i + 3], tokens[i + 4]];
    if (
      a?.kind === "ident" &&
      a.text === "include" &&
      b?.text === "!" &&
      c?.text === "(" &&
      d?.kind === "string" &&
      e?.text === ")"
    )
      found.push(d.text);
  }
  return found;
};

/**
 * The files a declaration may name. `cfg`: every `cfg_attr` path, each compiled on some
 * platform. `fallback`: the `#[path]`, or without one `foo.rs` then `foo/mod.rs`, of which
 * rustc takes the first that exists. `ownsDirectory` is true for a crate root, a `mod.rs` and
 * a `#[path]` file, whose children sit beside it; any other `foo.rs` keeps its children in
 * `foo/`. A block carrying `#[path]` starts again from the file's own directory, as rustc
 * does in either kind of file.
 */
export const candidates = (
  file: string,
  ownsDirectory: boolean,
  declaration: ModDeclaration,
): { readonly cfg: ReadonlyArray<string>; readonly fallback: ReadonlyArray<string> } => {
  const directory = dirname(file);
  const own = ownsDirectory ? directory : join(directory, basename(file).replace(/\.rs$/, ""));
  const pathed = declaration.inline.some((block) => block.path !== undefined);
  const blocks = declaration.inline.map((block) => block.path ?? block.name);
  const base = pathed ? join(directory, ...blocks) : join(own, ...blocks);
  const explicit = (path: string) =>
    blocks.length === 0 ? join(directory, path) : join(base, path);
  const cfg = declaration.cfgPaths.map(explicit);
  if (declaration.path !== undefined) return { cfg, fallback: [explicit(declaration.path)] };
  const module = join(base, declaration.name);
  return { cfg, fallback: [`${module}.rs`, `${module}/mod.rs`] };
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
      const { cfg, fallback } = candidates(item.file, item.ownsDirectory, declaration);
      const first = fallback.find((candidate) => texts.has(candidate));
      for (const file of cfg.filter((candidate) => texts.has(candidate)))
        queue.push({ file, ownsDirectory: true });
      if (first !== undefined)
        queue.push({
          file: first,
          ownsDirectory: declaration.path !== undefined || basename(first) === "mod.rs",
        });
    }
    // `include!` pastes the file's text in place: its items resolve as the includer's do.
    for (const included of includes(text)) {
      const file = join(dirname(item.file), included);
      if (texts.has(file)) queue.push({ file, ownsDirectory: item.ownsDirectory });
    }
  }
  return reached;
};
