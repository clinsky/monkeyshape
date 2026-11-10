/**
 * Module layering as data. Every source file under `arch.root` belongs to exactly one
 * module (the longest matching key in `arch.modules`). A module may import itself and the
 * modules in its `mayImport`; host APIs only with `hostAccess`; third-party packages only
 * from the allowlists. Adding an edge is a deliberate edit to `shape.config.ts`.
 *
 * Host access needs no import in Bun: `Bun.file`, `process`, `fetch` are globals. Direct
 * uses of those are checked too, respecting lexical shadowing. This is static analysis of
 * the common paths, not a sandbox: `globalThis.fetch`, `const { file } = Bun`, aliasing a
 * global to another name or `eval` still get through. It catches the habit, not an attacker.
 */

import { Visitor } from "oxc-parser";
import type { ResolvedConfig } from "../schemas/config.ts";
import { isTsSource, lineAt, type Snapshot, type Violation } from "./model.ts";
import { type Parsed, parse } from "./parse.ts";
import { dirname, join } from "./paths.ts";
import { scopes } from "./scope.ts";
import { isTest, placeOf } from "./sources.ts";

type Arch = NonNullable<ResolvedConfig["arch"]>;

const MANIFEST = "package.json";

/** Every rule this check reports, as `arch/<kind>`; test/core/ruleCases.test.ts covers each. */
export const ARCH_RULES = [
  "no-module-map",
  "config",
  "unknown-module",
  "host-access",
  "forbidden-package",
  "manifest",
  "unresolved-import",
  "forbidden-import",
  "cycle",
  "empty-module",
] as const;

const violation = (
  rule: (typeof ARCH_RULES)[number],
  file: string,
  message: string,
  line?: number,
): Violation => ({
  check: "arch",
  rule: `arch/${rule}`,
  file,
  ...(line === undefined ? {} : { line }),
  message,
});

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

/** `path` relative to `arch.root`, or undefined when it is outside it. `.` is the repo root. */
const underRoot = (arch: Arch, path: string): string | undefined =>
  arch.root === "."
    ? path
    : path.startsWith(`${arch.root}/`)
      ? path.slice(arch.root.length + 1)
      : undefined;

/** A module's directory from the repo root: its key is a path below `arch.root`. */
const directoryOf = (arch: Arch, name: string): string =>
  arch.root === "." ? name : `${arch.root}/${name}`;

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

interface HostUse {
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
): ReadonlyArray<HostUse> => {
  const uses: Array<HostUse> = [];
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
  const byOffset = new Map<number, HostUse>();
  for (const use of uses) if (!byOffset.has(use.offset)) byOffset.set(use.offset, use);
  return [...byOffset.values()].sort((a, b) => a.offset - b.offset);
};

/** The module key that would own a file: its directory below the root, or the file itself. */
const suggestModule = (rest: string): string => {
  const directory = rest.split("/").slice(0, -1).join("/");
  return directory === ""
    ? `Map the file itself as a module: a key may name one file, e.g. '${rest}'.`
    : `Add a module for its directory (a key is a path below \`arch.root\`, e.g. '${directory}').`;
};

export const moduleOf = (arch: Arch, path: string): string | undefined => {
  const rest = underRoot(arch, path);
  if (rest === undefined) return undefined;
  let best: string | undefined;
  for (const name of Object.keys(arch.modules))
    if (
      (rest === name || rest.startsWith(`${name}/`)) &&
      (best === undefined || name.length > best.length)
    )
      best = name;
  return best;
};

/**
 * The files arch layers: the code under `arch.root`, and any code in `sources` outside it,
 * which belongs to no module. Tests, declaration files and exempt files are not code here,
 * so a root of `.` doesn't ask a module for `tests/` or `shape.config.ts`.
 */
export const archFiles = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<string> => {
  const arch = config.arch;
  if (arch === undefined) return [];
  return snapshot.files.filter((file) => {
    if (!isTsSource(file)) return false;
    const kind = placeOf(config, file).kind;
    if (kind !== "source" && kind !== "outside") return false;
    return underRoot(arch, file) !== undefined || kind === "source";
  });
};

const packageName = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

/** `node:*` matches `node:fs/promises`: a trailing `*` is a prefix, not a path glob. */
export const matchesSpecifier = (specifier: string, pattern: string): boolean =>
  pattern.endsWith("*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern;

const isRelative = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

export const checkArch = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const arch = config.arch;
  // A repo with no TypeScript source has nothing to layer: arch is not-applicable there.
  if (arch === undefined && !snapshot.files.some((file) => isTsSource(file) && !isTest(file)))
    return [];
  if (arch === undefined)
    return [
      violation(
        "no-module-map",
        config.configFile,
        "declares no `arch.modules`. Layering is the cheapest structure to enforce; map every source directory to a module.",
      ),
    ];

  const violations: Array<Violation> = [];
  for (const [name, rule] of Object.entries(arch.modules))
    for (const target of rule.mayImport ?? [])
      if (!Object.hasOwn(arch.modules, target))
        violations.push(
          violation(
            "config",
            config.configFile,
            `module '${name}' lists unknown module '${target}' in mayImport`,
          ),
        );

  const files = archFiles(config, snapshot);
  for (const [name, rule] of Object.entries(arch.modules))
    if (
      rule.optional !== true &&
      !files.some(
        (file) =>
          file === directoryOf(arch, name) || file.startsWith(`${directoryOf(arch, name)}/`),
      )
    )
      violations.push(
        violation(
          "empty-module",
          config.configFile,
          `module '${name}' matches no TypeScript file under ${directoryOf(arch, name)}/. Fix its name, remove it, or mark it \`optional: true\` if its code is still to come.`,
        ),
      );

  const known = new Set(snapshot.files);
  const edges = new Map<string, Array<string>>();

  for (const file of files) {
    const from = moduleOf(arch, file);
    if (from === undefined) {
      violations.push(
        violation(
          "unknown-module",
          file,
          underRoot(arch, file) === undefined
            ? `is in \`sources\` but outside \`arch.root\` ('${arch.root}'), so no module owns it. Set \`arch.root: "."\` and map its directory as a module, or move it under ${arch.root}/.`
            : `is not inside any module in \`arch.modules\` (${config.configFile}). ${suggestModule(underRoot(arch, file) ?? file)}`,
        ),
      );
      continue;
    }
    const rule = arch.modules[from];
    const text = snapshot.texts.get(file);
    if (rule === undefined || text === undefined) continue;
    const targets: Array<string> = [];
    const parsed = parse(file, text);

    if (rule.hostAccess !== true)
      for (const use of hostGlobals(parsed))
        violations.push(
          violation(
            "host-access",
            file,
            `uses ${use.name}, but module '${from}' has no hostAccess. Reach the host through a service in an adapter module.`,
            lineAt(text, use.offset),
          ),
        );

    const isHost = (specifier: string) =>
      arch.hostSpecifiers.some((pattern) => matchesSpecifier(specifier, pattern));
    if (rule.hostAccess !== true)
      for (const use of hostUses(parsed, isHost))
        violations.push(
          violation(
            "host-access",
            file,
            `${use.what}, but module '${from}' has no hostAccess. Reach the host through a service in an adapter module, or use a pure operation.`,
            lineAt(text, use.offset),
          ),
        );

    for (const specifier of parsed.imports) {
      if (!isRelative(specifier)) {
        if (isHost(specifier)) continue;
        if (
          !arch.allowedPackages.includes(packageName(specifier)) &&
          !(rule.packages ?? []).includes(packageName(specifier))
        )
          violations.push(
            violation(
              "forbidden-package",
              file,
              `imports '${specifier}', which module '${from}' may not use. Add it to the module's packages deliberately, or keep it behind an adapter.`,
            ),
          );
        continue;
      }
      const target = join(dirname(file), specifier);
      if (target === MANIFEST) {
        if (rule.manifest !== true)
          violations.push(
            violation("manifest", file, `module '${from}' may not import package.json`),
          );
        continue;
      }
      if (!known.has(target)) {
        violations.push(
          violation(
            "unresolved-import",
            file,
            `cannot resolve '${specifier}' (use explicit .ts extensions)`,
          ),
        );
        continue;
      }
      targets.push(target);
      const to = moduleOf(arch, target);
      if (to !== undefined && to !== from && !(rule.mayImport ?? []).includes(to))
        violations.push(
          violation(
            "forbidden-import",
            file,
            `module '${from}' may not import module '${to}' ('${specifier}')`,
          ),
        );
    }
    edges.set(file, targets);
  }

  for (const cycle of findCycles(edges))
    violations.push(violation("cycle", cycle[0] ?? "", `import cycle: ${cycle.join(" -> ")}`));
  return violations;
};

/** Depth-first search reporting each back edge as a cycle (file-level). */
export const findCycles = (
  edges: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<ReadonlyArray<string>> => {
  const cycles: Array<ReadonlyArray<string>> = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: Array<string> = [];

  const visit = (node: string): void => {
    state.set(node, "visiting");
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const nextState = state.get(next);
      if (nextState === "visiting") cycles.push([...stack.slice(stack.indexOf(next)), next]);
      else if (nextState === undefined) visit(next);
    }
    stack.pop();
    state.set(node, "done");
  };

  for (const node of [...edges.keys()].sort()) if (!state.has(node)) visit(node);
  return cycles;
};
