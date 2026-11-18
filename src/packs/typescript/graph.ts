/**
 * TypeScript's graph for `arch`: each source's imports, resolved to repo files, packages or the
 * manifest, and its uses of the host.
 *
 * Host access needs no import in Bun: `Bun.file`, `process`, `fetch` are globals. Direct
 * uses of those are checked too, respecting lexical shadowing. This is static analysis of
 * the common paths, not a sandbox: `globalThis.fetch`, `const { file } = Bun`, aliasing a
 * global to another name or `eval` still get through. It catches the habit, not an attacker.
 */
import { Visitor } from "oxc-parser";
import { lineAt } from "../../core/model.ts";
import { type Parsed, parse } from "../../core/parse.ts";
import { dirname, join } from "../../core/paths.ts";
import { scopes } from "../../core/scope.ts";
import type { Edge, Graph, GraphInput, HostUse } from "../pack.ts";

const MANIFEST = "package.json";

/** Bun's pure utilities: string and data functions with no I/O. */
const PURE_BUN: ReadonlySet<string> = new Set([
  "Glob",
  "deepEquals",
  "escapeHTML",
  "stringWidth",
  "hash",
  "inspect",
  "CryptoHasher",
  "sha",
  "zstdCompressSync",
  "zstdDecompressSync",
  "gzipSync",
  "gunzipSync",
  "deflateSync",
  "inflateSync",
  // Parsers of a string already in memory.
  "JSONC",
  "YAML",
  "TOML",
]);

/**
 * `Glob` is pure for `.match`, but `.scan` and `.scanSync` read directories. Which object a
 * call is on isn't tracked, so any such call in a file makes every `Glob` there host access.
 */
const scansDisk = (parsed: Parsed): boolean => {
  let found = false;
  new Visitor({
    CallExpression: (node) => {
      const callee = node.callee;
      if (
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.property.type === "Identifier" &&
        (callee.property.name === "scan" || callee.property.name === "scanSync")
      )
        found = true;
    },
  }).visit(parsed.program);
  return found;
};

const pureBun = (name: string, scans: boolean): boolean =>
  PURE_BUN.has(name) && !(name === "Glob" && scans);
const HOST_OBJECTS = new Set(["Bun", "process", "Deno"]);
const HOST_FUNCTIONS = new Set(["fetch", "require"]);

/** Uses of host globals: `Bun.file(...)`, `process.cwd()`, `fetch(...)`, unless shadowed there. */
export const hostGlobals = (parsed: Parsed): ReadonlyArray<{ offset: number; name: string }> => {
  const found: Array<{ offset: number; name: string }> = [];
  const local = scopes(parsed.program);
  const scans = scansDisk(parsed);
  new Visitor({
    MemberExpression: (node) => {
      if (node.object.type !== "Identifier" || !HOST_OBJECTS.has(node.object.name)) return;
      if (local.isLocal(node.object.name, node.start)) return;
      const property =
        !node.computed && node.property.type === "Identifier" ? node.property.name : "";
      if (node.object.name === "Bun" && pureBun(property, scans)) return;
      found.push({ offset: node.start, name: `${node.object.name}.${property || "[...]"}` });
    },
    CallExpression: (node) => {
      if (
        node.callee.type === "Identifier" &&
        HOST_FUNCTIONS.has(node.callee.name) &&
        !local.isLocal(node.callee.name, node.start)
      )
        found.push({ offset: node.start, name: `${node.callee.name}()` });
    },
  }).visit(parsed.program);
  return found;
};

const PATH_PURE = [
  "join",
  "normalize",
  "dirname",
  "basename",
  "extname",
  "isAbsolute",
  "parse",
  "format",
  "sep",
  "delimiter",
];

/**
 * Operations of host modules that touch nothing outside the process: computation over
 * values. `createHash` is pure, `randomBytes` is not (entropy), `path.resolve` is not (the
 * working directory). A name not listed here is host access; the list grows by a case that
 * shows the need, never by a whole module.
 */
export const PURE_OPERATIONS: Readonly<Record<string, ReadonlySet<string>>> = {
  "node:crypto": new Set(["createHash", "createHmac", "getHashes", "timingSafeEqual", "hash"]),
  "node:zlib": new Set([
    "constants",
    "crc32",
    ...["Inflate", "InflateRaw", "Deflate", "DeflateRaw", "Gzip", "Gunzip", "Unzip"].flatMap(
      (name) => [`create${name}`, `${name[0]?.toLowerCase()}${name.slice(1)}Sync`],
    ),
    "createBrotliCompress",
    "createBrotliDecompress",
    "brotliCompressSync",
    "brotliDecompressSync",
  ]),
  "node:stream": new Set(["Readable", "Writable", "Duplex", "Transform", "PassThrough", "Stream"]),
  "node:buffer": new Set(["Buffer", "constants"]),
  "node:util": new Set([
    "inspect",
    "format",
    "isDeepStrictEqual",
    "types",
    "TextEncoder",
    "TextDecoder",
  ]),
  "node:path": new Set(PATH_PURE),
  "node:path/posix": new Set(PATH_PURE),
};

/** `import { Glob } from "bun"` is the same operation as `Bun.Glob`, and as pure. */
const isPure = (specifier: string, name: string, scans: boolean): boolean =>
  specifier === "bun" ? pureBun(name, scans) : PURE_OPERATIONS[specifier]?.has(name) === true;

interface HostSite {
  readonly offset: number;
  readonly what: string;
}

/**
 * Each way a file reaches a host module: an import of a name that isn't a pure operation, a
 * namespace or default import used for one (or passed whole), a side-effect import, a
 * re-export, and a dynamic import of a host module or of one computed at runtime. Type-only
 * imports reach nothing at runtime and are never host access.
 */
export const hostUses = (
  parsed: Parsed,
  isHost: (specifier: string) => boolean,
): ReadonlyArray<HostSite> => {
  const uses: Array<HostSite> = [];
  const namespaces = new Map<string, string>();
  const scans = scansDisk(parsed);
  const declarations: Array<{ start: number; end: number }> = [];
  for (const statement of parsed.program.body) {
    if (statement.type === "ImportDeclaration") {
      declarations.push(statement);
      const source = statement.source.value;
      if (!isHost(source) || statement.importKind === "type") continue;
      if (statement.specifiers.length === 0)
        uses.push({ offset: statement.start, what: `imports '${source}' for its side effects` });
      for (const specifier of statement.specifiers) {
        if (specifier.type === "ImportSpecifier") {
          if (specifier.importKind === "type") continue;
          const name =
            specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : String(specifier.imported.value);
          if (!isPure(source, name, scans))
            uses.push({ offset: specifier.start, what: `imports ${name} from '${source}'` });
        } else namespaces.set(specifier.local.name, source);
      }
    } else if (
      (statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") &&
      statement.source !== null &&
      isHost(statement.source.value) &&
      statement.exportKind !== "type"
    )
      uses.push({ offset: statement.start, what: `re-exports from '${statement.source.value}'` });
  }

  const local = scopes(parsed.program);
  const imported = (name: string, offset: number) =>
    namespaces.has(name) && local.bindingAt(name, offset)?.kind === "import";
  const inImport = (offset: number) =>
    declarations.some((range) => offset >= range.start && offset < range.end);
  const judged = new Set<number>();
  new Visitor({
    TSQualifiedName: (node) => {
      if (node.left.type === "Identifier") judged.add(node.left.start);
    },
    TSTypeQuery: (node) => {
      if (node.exprName.type === "Identifier") judged.add(node.exprName.start);
    },
    MemberExpression: (node) => {
      if (node.object.type !== "Identifier" || !imported(node.object.name, node.start)) return;
      judged.add(node.object.start);
      const source = namespaces.get(node.object.name) ?? "";
      const property =
        !node.computed && node.property.type === "Identifier" ? node.property.name : "[...]";
      if (!isPure(source, property, scans))
        uses.push({
          offset: node.start,
          what: `uses ${node.object.name}.${property} from '${source}'`,
        });
    },
    Identifier: (node) => {
      if (judged.has(node.start) || inImport(node.start) || !imported(node.name, node.start))
        return;
      uses.push({
        offset: node.start,
        what: `uses ${node.name} from '${namespaces.get(node.name)}' as a whole`,
      });
    },
    ImportExpression: (node) => {
      const source = node.source;
      const literal =
        source.type === "Literal" && typeof source.value === "string"
          ? source.value
          : source.type === "TemplateLiteral" && source.expressions.length === 0
            ? source.quasis.map((quasi) => quasi.value.cooked ?? "").join("")
            : undefined;
      if (literal === undefined)
        uses.push({
          offset: node.start,
          what: "imports a module computed at runtime, which may be a host module",
        });
      else if (isHost(literal))
        uses.push({ offset: node.start, what: `imports '${literal}' dynamically` });
    },
  }).visit(parsed.program);
  // `export { ns }` holds `ns` twice at one offset (local and exported): one use, not two.
  const byOffset = new Map<number, HostSite>();
  for (const use of uses) if (!byOffset.has(use.offset)) byOffset.set(use.offset, use);
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset);
};

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/**
 * Each file's host uses (globals first, then modules), then its imports, in the order the file
 * writes them. A host specifier is no edge: its use is judged as host access instead.
 */
export const graph = ({ files, known, texts, isHost }: GraphInput): Graph => {
  const edges: Array<Edge> = [];
  const uses: Array<HostUse> = [];
  for (const file of files) {
    const text = texts.get(file);
    if (text === undefined) continue;
    const parsed = parse(file, text);
    for (const use of hostGlobals(parsed))
      uses.push({ file, line: lineAt(text, use.offset), what: `uses ${use.name}` });
    for (const use of hostUses(parsed, isHost))
      uses.push({
        file,
        line: lineAt(text, use.offset),
        what: use.what,
        alternative: "use a pure operation",
      });
    for (const written of parsed.imports) {
      const from = { from: file, written };
      if (!isRelative(written)) {
        if (!isHost(written)) edges.push({ ...from, package: packageName(written) });
        continue;
      }
      const target = join(dirname(file), written);
      if (target === MANIFEST) edges.push({ ...from, manifest: target });
      else if (!known.has(target))
        edges.push({
          ...from,
          unresolved: `cannot resolve '${written}' (use explicit .ts extensions)`,
        });
      else edges.push({ ...from, to: target });
    }
  }
  return { edges, hostUses: uses };
};
