/**
 * Python's graph for `arch`: each source's imports, resolved to repo files or packages, and its
 * uses of the host.
 *
 * An absolute import is first-party when its top-level name is a package or module in an
 * import root: the repo's root and, for every `pyproject.toml`, its directory and its `src/`
 * (a uv project, a workspace member, the src layout). It resolves to the deepest module the
 * import names, so arch layers by file: `from app.core import model` is an edge to
 * `app/core/model.py` when that is a module, else to `app/core/__init__.py`. A standard-library
 * import is the language's own and no edge; any other is a package edge on its top-level name,
 * the name `packages` lists (the import name, `yaml`, not the distribution's, `pyyaml`).
 *
 * Host access is an import of a host module (`hostSpecifiers`: `os`, `subprocess`, ...) and a
 * call of the builtin `open` where the file doesn't bind that name itself. Like the TypeScript
 * pack's, this catches the habit, not an attacker: `importlib`, `__import__` and `getattr`
 * still get through.
 */
import { lineAt } from "../../core/model.ts";
import { dirname } from "../../core/paths.ts";
import type { Edge, Graph, GraphInput, HostUse } from "../pack.ts";
import { type Import, importsOf } from "./imports.ts";
import { lex } from "./lexer.ts";
import { STDLIB } from "./stdlib.ts";

const join = (...parts: ReadonlyArray<string>): string =>
  parts.filter((part) => part !== "").join("/");

/** Where absolute imports resolve from, deepest first, so `src/app` wins over `src.app`. */
export const importRoots = (known: ReadonlySet<string>): ReadonlyArray<string> => {
  const roots = new Set([""]);
  for (const file of known)
    if (file === "pyproject.toml" || file.endsWith("/pyproject.toml")) {
      const dir = dirname(file);
      roots.add(dir);
      roots.add(join(dir, "src"));
    }
  return [...roots].sort((a, b) => b.split("/").length - a.split("/").length || b.localeCompare(a));
};

/** The file a module path (`app/core`) is, as a module or a package, if the repo has it. */
const moduleFile = ({ known }: Repo, path: string): string | undefined =>
  [`${path}.py`, `${path}/__init__.py`, `${path}.pyi`, `${path}/__init__.pyi`].find((file) =>
    known.has(file),
  );

/** Every directory holding Python at any depth: a package, maybe a namespace one. */
const pythonDirs = (known: ReadonlySet<string>): ReadonlySet<string> => {
  const dirs = new Set<string>();
  for (const file of known)
    if (file.endsWith(".py") || file.endsWith(".pyi"))
      for (let dir = dirname(file); dir !== "" && !dirs.has(dir); dir = dirname(dir)) dirs.add(dir);
  return dirs;
};

interface Repo {
  readonly known: ReadonlySet<string>;
  /** `pythonDirs(known)`. */
  readonly dirs: ReadonlySet<string>;
}

type Resolved =
  | { readonly to: ReadonlyArray<string> }
  | { readonly unresolved: string }
  | { readonly outside: true };

/**
 * The files an import at `base` (a directory path standing for its package) reaches: the
 * module itself, or for `from` each imported name that is a submodule, else the module.
 */
const resolveAt = (repo: Repo, base: string, found: Import): ReadonlyArray<string> | undefined => {
  const path = join(base, ...found.module.split(".").filter((part) => part !== ""));
  const module = moduleFile(repo, path);
  if (found.names === undefined) return module === undefined ? undefined : [module];
  const submodules = found.names.flatMap((name) => {
    const file = name === "*" ? undefined : moduleFile(repo, join(path, name));
    return file === undefined ? [] : [file];
  });
  const rest = found.names.length > submodules.length;
  if (rest && module === undefined && !(submodules.length > 0 || repo.dirs.has(path)))
    return undefined;
  return [...new Set([...submodules, ...(rest && module !== undefined ? [module] : [])])];
};

const resolve = (
  repo: Repo,
  roots: ReadonlyArray<string>,
  file: string,
  found: Import,
): Resolved => {
  if (found.level > 0) {
    let base = dirname(file);
    for (let up = 1; up < found.level; up++) {
      if (base === "") return { unresolved: `\`${found.written}\` climbs above the repo` };
      base = dirname(base);
    }
    const to = resolveAt(repo, base, found);
    return to === undefined
      ? { unresolved: `cannot resolve \`${found.written}\` from ${file}` }
      : { to };
  }
  const top = found.module.split(".")[0] ?? "";
  for (const root of roots) {
    const topPath = join(root, top);
    if (moduleFile(repo, topPath) === undefined && !repo.dirs.has(topPath)) continue;
    const to = resolveAt(repo, root, found);
    return to === undefined
      ? {
          unresolved: `cannot resolve \`${found.written}\`: ${topPath} is in the repo, but the module it names isn't`,
        }
      : { to };
  }
  return { outside: true };
};

/** Names a file binds to `open` itself, which then isn't the builtin. */
const BINDS_OPEN =
  /(?:^|\n)\s*(?:(?:async\s+)?def\s+open\b|class\s+open\b|open\s*(?::[^=\n]*)?=(?!=)|(?:from\s+\S+\s+)?import\s+[^\n]*\bopen\b)/;

/** Calls of the builtin `open`, as offsets: `open(` that isn't an attribute (`path.open(`). */
const builtinOpens = (text: string): ReadonlyArray<number> => {
  const { code } = lex(text);
  if (BINDS_OPEN.test(code)) return [];
  return [...code.matchAll(/(?<![\p{L}\p{N}_.])open\s*\(/gu)].map((match) => match.index);
};

export const graph = ({ files, known, texts, isHost }: GraphInput): Graph => {
  const roots = importRoots(known);
  const repo: Repo = { known, dirs: pythonDirs(known) };
  const edges: Array<Edge> = [];
  const hostUses: Array<HostUse> = [];
  for (const file of files) {
    const text = texts.get(file);
    if (text === undefined) continue;
    for (const offset of builtinOpens(text))
      hostUses.push({
        file,
        line: lineAt(text, offset),
        what: "calls the builtin open()",
        alternative: "take the text or a file object as an argument",
      });
    for (const found of importsOf(text)) {
      const base = { from: file, line: found.line, written: found.written };
      const resolved = resolve(repo, roots, file, found);
      if ("to" in resolved) {
        for (const to of resolved.to) if (to !== file) edges.push({ ...base, to });
        continue;
      }
      if ("unresolved" in resolved) {
        edges.push({ ...base, unresolved: resolved.unresolved });
        continue;
      }
      const names = found.names ?? [];
      const host = [found.module, ...names.map((name) => `${found.module}.${name}`)].find(isHost);
      if (host !== undefined) {
        hostUses.push({
          file,
          line: found.line,
          what: `imports '${host}'`,
          alternative: "pass in what it computes",
        });
        continue;
      }
      const top = found.module.split(".")[0] ?? found.module;
      if (!STDLIB.has(top)) edges.push({ ...base, package: top });
    }
  }
  return { edges, hostUses };
};
