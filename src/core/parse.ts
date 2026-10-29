/** One parse per file, shared by the arch, rules and refs checks. */
import { type Comment, type Program, parseSync } from "oxc-parser";

export interface Parsed {
  readonly path: string;
  readonly text: string;
  readonly program: Program;
  readonly comments: ReadonlyArray<Comment>;
  /** Static, re-export and literal dynamic import specifiers (type-only included). */
  readonly imports: ReadonlyArray<string>;
  readonly syntaxErrors: ReadonlyArray<string>;
}

const cache = new Map<string, Parsed>();

export const parse = (path: string, text: string): Parsed => {
  const cached = cache.get(path);
  if (cached !== undefined && cached.text === text) return cached;
  const lang = path.endsWith("x") ? "tsx" : "ts";
  const result = parseSync(path, text, { lang, preserveParens: false });
  const imports: Array<string> = [];
  for (const entry of result.module.staticImports) imports.push(entry.moduleRequest.value);
  for (const entry of result.module.staticExports)
    for (const item of entry.entries)
      if (item.moduleRequest !== null) imports.push(item.moduleRequest.value);
  for (const entry of result.module.dynamicImports) {
    const literal = text.slice(entry.moduleRequest.start, entry.moduleRequest.end);
    const match = /^["'`]([^"'`$]+)["'`]$/.exec(literal);
    if (match?.[1] !== undefined) imports.push(match[1]);
  }
  const parsed: Parsed = {
    path,
    text,
    program: result.program,
    comments: result.comments,
    imports: [...new Set(imports)],
    syntaxErrors: result.errors.map((error) => error.message),
  };
  cache.set(path, parsed);
  return parsed;
};
