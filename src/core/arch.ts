/**
 * Module layering as data. Every source file under `arch.root` belongs to exactly one
 * module (the longest matching key in `arch.modules`). A module may import itself and the
 * modules in its `mayImport`; host APIs only with `hostAccess`; third-party packages only
 * from the allowlists. Adding an edge is a deliberate edit to the config (`shape.toml`).
 *
 * The check names no language: each listed pack builds the graph of its own files (`graph`),
 * resolved to repo paths, packages and host uses, and this judges it. Graphs are per pack, so
 * an import between two packs' files is no edge.
 */

import type { LoadedPack } from "../packs/pack.ts";
import type { ResolvedConfig } from "../schemas/config.ts";
import type { Snapshot, Violation } from "./model.ts";
import { claimOf, placeOf } from "./sources.ts";

type Arch = NonNullable<ResolvedConfig["arch"]>;

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

/** `path` relative to `arch.root`, or undefined when it is outside it. `.` is the repo root. */
const underRoot = (arch: Arch, path: string): string | undefined =>
  arch.root === "."
    ? path
    : path.startsWith(`${arch.root}/`)
      ? path.slice(arch.root.length + 1)
      : undefined;

/**
 * Where a module's files are, from the repo root: its `paths`, or else its key below
 * `arch.root`.
 */
const directoriesOf = (arch: Arch, name: string): ReadonlyArray<string> =>
  (arch.modules[name]?.paths ?? [arch.root === "." ? name : `${arch.root}/${name}`]).map((path) =>
    path.replace(/^(\.\/)+/, "").replace(/\/+$/, ""),
  );

/** Whether `path` is `directory` itself or below it. */
const within = (path: string, directory: string): boolean =>
  directory === "." || directory === "" || path === directory || path.startsWith(`${directory}/`);

/** The module key that would own a file: its directory below the root, or the file itself. */
const suggestModule = (rest: string): string => {
  const directory = rest.split("/").slice(0, -1).join("/");
  return directory === ""
    ? `Map the file itself as a module: a key may name one file, e.g. '${rest}'.`
    : `Add a module for its directory (a key is a path below \`arch.root\`, e.g. '${directory}').`;
};

/** The module owning `path`: the one whose directory holds it most closely. */
export const moduleOf = (arch: Arch, path: string): string | undefined => {
  let best: { name: string; length: number } | undefined;
  for (const name of Object.keys(arch.modules))
    for (const directory of directoriesOf(arch, name))
      if (within(path, directory) && (best === undefined || directory.length > best.length))
        best = { name, length: directory.length };
  return best?.name;
};

/**
 * The files arch layers: the code under `arch.root`, and any code in `sources` outside it,
 * which belongs to no module. Tests, declaration files and exempt files are not code here,
 * so a root of `.` doesn't ask a module for `tests/` or `shape.config.ts`; nor are the local
 * rules the config imports, unless a module maps them: they are the config's, as it is mshape's.
 * With `pack`, only that pack's files.
 */
export const archFiles = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  pack?: LoadedPack,
): ReadonlyArray<string> => {
  const arch = config.arch;
  if (arch === undefined) return [];
  return snapshot.files.filter((file) => {
    const claim = claimOf(snapshot, file);
    if (claim === undefined || (pack !== undefined && claim.loaded !== pack)) return false;
    if (claim.kind === "declaration") return false;
    if (config.configModules.includes(file) && moduleOf(arch, file) === undefined) return false;
    const kind = placeOf(config, file, claim.kind).kind;
    if (kind !== "source" && kind !== "outside") return false;
    return (
      underRoot(arch, file) !== undefined || kind === "source" || moduleOf(arch, file) !== undefined
    );
  });
};

/** Whether any listed pack has code, tests aside: a repo with none has nothing to layer. */
const hasCode = (snapshot: Snapshot): boolean =>
  snapshot.files.some((file) => claimOf(snapshot, file)?.kind === "source");

/** `node:*` matches `node:fs/promises`: a trailing `*` is a prefix, not a path glob. */
export const matchesSpecifier = (specifier: string, pattern: string): boolean =>
  pattern.endsWith("*") ? specifier.startsWith(pattern.slice(0, -1)) : specifier === pattern;

/** The languages of the listed packs, for "matches no <language> file". */
const languages = (snapshot: Snapshot): string =>
  snapshot.packs.map(({ pack }) => pack.language).join(" or ");

export const checkArch = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const arch = config.arch;
  if (arch === undefined && !hasCode(snapshot)) return [];
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
  for (const [name, rule] of Object.entries(arch.modules)) {
    const directories = directoriesOf(arch, name);
    if (rule.optional !== true && !files.some((file) => directories.some((d) => within(file, d))))
      violations.push(
        violation(
          "empty-module",
          config.configFile,
          `module '${name}' matches no ${languages(snapshot)} file under ${directories.map((d) => `${d}/`).join(" or ")}. Fix its ${rule.paths === undefined ? "name" : "paths"}, remove it, or mark it \`optional: true\` if its code is still to come.`,
        ),
      );
  }

  const known = new Set(snapshot.files);
  const isHost = (specifier: string) =>
    arch.hostSpecifiers.some((pattern) => matchesSpecifier(specifier, pattern));
  for (const loaded of snapshot.packs)
    violations.push(
      ...judge(config, arch, loaded, archFiles(config, snapshot, loaded), {
        known,
        texts: snapshot.texts,
        isHost,
        claimed: (file) => claimOf(snapshot, file)?.loaded,
      }),
    );
  return violations;
};

/** One pack's graph, judged: each file's module, its host uses and its edges, then cycles. */
const judge = (
  config: ResolvedConfig,
  arch: Arch,
  loaded: LoadedPack,
  files: ReadonlyArray<string>,
  repo: {
    readonly known: ReadonlySet<string>;
    readonly texts: Snapshot["texts"];
    readonly isHost: (specifier: string) => boolean;
    readonly claimed: (file: string) => LoadedPack | undefined;
  },
): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = [];
  const { edges, hostUses } = loaded.pack.graph({
    config,
    files,
    known: repo.known,
    texts: repo.texts,
    outputs: loaded.load.outputs,
    isHost: repo.isHost,
  });
  const targets = new Map<string, Array<string>>();
  for (const file of files) {
    const from = moduleOf(arch, file);
    if (from !== undefined) continue;
    violations.push(
      violation(
        "unknown-module",
        file,
        underRoot(arch, file) === undefined
          ? `is in \`sources\` but outside \`arch.root\` ('${arch.root}'), so no module owns it. Set \`arch.root: "."\` and map its directory as a module, or move it under ${arch.root}/.`
          : `is not inside any module in \`arch.modules\` (${config.configFile}). ${suggestModule(underRoot(arch, file) ?? file)}`,
      ),
    );
  }
  for (const use of hostUses) {
    const from = moduleOf(arch, use.file);
    const rule = from === undefined ? undefined : arch.modules[from];
    if (rule === undefined || rule.hostAccess === true) continue;
    violations.push(
      violation(
        "host-access",
        use.file,
        `${use.what}, but module '${from}' has no hostAccess. Reach the host through a service in an adapter module${use.alternative === undefined ? "" : `, or ${use.alternative}`}.`,
        use.line,
      ),
    );
  }
  for (const edge of edges) {
    const from = moduleOf(arch, edge.from);
    const rule = from === undefined ? undefined : arch.modules[from];
    // A layered file no module owns was reported above; its edges say nothing more.
    if (rule === undefined) continue;
    if ("package" in edge) {
      if (
        !arch.allowedPackages.includes(edge.package) &&
        !(rule.packages ?? []).includes(edge.package)
      )
        violations.push(
          violation(
            "forbidden-package",
            edge.from,
            `imports '${edge.written}', which module '${from}' may not use. Add it to the module's packages deliberately, or keep it behind an adapter.`,
            edge.line,
          ),
        );
    } else if ("manifest" in edge) {
      if (rule.manifest !== true)
        violations.push(
          violation(
            "manifest",
            edge.from,
            `module '${from}' may not import ${edge.manifest}`,
            edge.line,
          ),
        );
    } else if ("unresolved" in edge) {
      violations.push(violation("unresolved-import", edge.from, edge.unresolved, edge.line));
    } else {
      // Graphs are per pack: an edge into a file another listed pack claims is no edge.
      const owner = repo.claimed(edge.to);
      if (owner !== undefined && owner !== loaded) continue;
      const list = targets.get(edge.from) ?? [];
      list.push(edge.to);
      targets.set(edge.from, list);
      const to = moduleOf(arch, edge.to);
      if (to !== undefined && to !== from && !(rule.mayImport ?? []).includes(to))
        violations.push(
          violation(
            "forbidden-import",
            edge.from,
            `module '${from}' may not import module '${to}' ('${edge.written}')`,
            edge.line,
          ),
        );
    }
  }
  for (const cycle of findCycles(targets))
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
