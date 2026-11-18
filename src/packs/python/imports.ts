/**
 * The import statements in a Python file, read from the lexer's blanked code: `import a.b as
 * c, d` and `from ..a import (b, c)`, wherever they sit (a function, an `if TYPE_CHECKING:`
 * block), across bracketed and backslash-continued lines and `;`-separated statements. Not
 * read: `importlib.import_module` and `__import__`, whose module is a runtime value.
 */
import { lex } from "./lexer.ts";

export interface Import {
  /** 1-based, where the statement starts. */
  readonly line: number;
  /** Leading dots of a relative import: 0 for an absolute one. */
  readonly level: number;
  /** The dotted module, `a.b`; empty in `from . import x`. */
  readonly module: string;
  /** What `from` imports; undefined for a plain `import`. `*` for a star import. */
  readonly names: ReadonlyArray<string> | undefined;
  /** As written, for the message: `from ..a import b`, `import a.b`. */
  readonly written: string;
}

const DOTTED = /^[\p{L}_][\p{L}\p{N}_]*(?:\s*\.\s*[\p{L}_][\p{L}\p{N}_]*)*$/u;
const NAME = /^[\p{L}_][\p{L}\p{N}_]*$/u;

/** A statement's text with its start, split at newlines outside brackets and continuations. */
interface Statement {
  readonly text: string;
  readonly start: number;
}

/** Logical lines, then the `;`-separated statements in each, from blanked code. */
const statements = (code: string): ReadonlyArray<Statement> => {
  const out: Array<Statement> = [];
  let depth = 0;
  let start = 0;
  const push = (end: number) => {
    let from = start;
    for (const part of code.slice(start, end).split(";")) {
      out.push({ text: part, start: from });
      from += part.length + 1;
    }
  };
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === "(" || char === "[" || char === "{") depth++;
    else if ((char === ")" || char === "]" || char === "}") && depth > 0) depth--;
    else if (char === "\\" && code[i + 1] === "\n") i++;
    else if (char === "\\" && code[i + 1] === "\r" && code[i + 2] === "\n") i += 2;
    else if (char === "\n" && depth === 0) {
      push(i);
      start = i + 1;
    }
  }
  push(code.length);
  return out;
};

/** Collapses continuations and brackets' line breaks to single spaces. */
const flat = (text: string): string =>
  text
    .replace(/\\\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const lineOf = (code: string, offset: number): number => {
  let line = 1;
  for (let i = 0; i < offset; i++) if (code.charCodeAt(i) === 10) line++;
  return line;
};

/** `a.b as c` → `a.b`; undefined when it isn't a dotted name with an optional alias. */
const target = (part: string): string | undefined => {
  const [name, ...alias] = part.trim().split(/\s+as\s+/);
  if (name === undefined || !DOTTED.test(name)) return undefined;
  if (alias.length > 1 || (alias.length === 1 && !NAME.test(alias[0] ?? ""))) return undefined;
  return name.replace(/\s+/g, "");
};

/**
 * One statement as an import, or none. A compound statement's body on its own line
 * (`if x: import y`) is read too, after the last `:` of a header keyword.
 */
const parseStatement = (raw: string): ReadonlyArray<Omit<Import, "line">> => {
  let text = flat(raw);
  const header = /^(?:if|elif|else|try|except|finally|with|for|while|def|class)\b.*?:\s*(.+)$/.exec(
    text,
  );
  if (header?.[1] !== undefined && /^(?:import|from)\b/.test(header[1])) text = header[1];
  const plain = /^import\s+(.+)$/.exec(text);
  if (plain?.[1] !== undefined) {
    const modules = plain[1].split(",").map(target);
    if (modules.some((module) => module === undefined)) return [];
    return (modules as Array<string>).map((module) => ({
      level: 0,
      module,
      names: undefined,
      written: `import ${module}`,
    }));
  }
  const from = /^from\s+(\.*)\s*([^\s.][^\s]*?)?\s+import\s+(.+)$/.exec(text);
  if (from === null) return [];
  const level = from[1]?.length ?? 0;
  const module = (from[2] ?? "").replace(/\s+/g, "");
  if (module !== "" && !DOTTED.test(module)) return [];
  if (level === 0 && module === "") return [];
  const list = (from[3] ?? "").replace(/^\(\s*/, "").replace(/\s*,?\s*\)$/, "");
  const names =
    list.trim() === "*"
      ? ["*"]
      : list
          .split(",")
          .filter((part) => part.trim() !== "")
          .map(target);
  if (names.some((name) => name === undefined || name.includes("."))) return [];
  return [
    {
      level,
      module,
      names: names as Array<string>,
      written: `from ${".".repeat(level)}${module} import ${(names as Array<string>).join(", ")}`,
    },
  ];
};

/** Every import statement in `text`, in order. */
export const importsOf = (text: string): ReadonlyArray<Import> => {
  const { code } = lex(text);
  return statements(code).flatMap((statement) => {
    const offset = statement.start + (statement.text.length - statement.text.trimStart().length);
    const line = lineOf(code, offset);
    return parseStatement(statement.text).map((found) => ({ ...found, line }));
  });
};
