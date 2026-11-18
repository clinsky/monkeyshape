/**
 * The crate graph as edges `arch` judges: from a member's `Cargo.toml` to another member's
 * (a `to` edge, mapped to modules by path) or to an external crate (a `package` edge). Dev
 * dependencies are left out: they are tests' edges, and arch layers code. A build dependency
 * runs at build time and is kept. Each edge sits at the manifest line that declares it.
 */
import type { Crate, Workspace } from "./metadata.ts";

export type CrateEdge = {
  readonly from: string;
  readonly line: number;
  readonly written: string;
} & ({ readonly to: string } | { readonly package: string });

/** `[dependencies]`, `[build-dependencies]`, `[target.'cfg(unix)'.dependencies]` and so on. */
const DEPENDENCY_TABLE =
  /^(?:target\.(?:'[^']*'|"[^"]*"|[^.]+)\.)?(dependencies|build-dependencies)$/;

const unquote = (key: string): string => key.trim().replace(/^["']|["']$/g, "");

/**
 * The 1-based line declaring `key` in a dependency table of `manifest`, as an inline key
 * (`serde = "1"`, `serde.workspace = true`) or a table of its own (`[dependencies.serde]`).
 * Undefined when the text doesn't show it; the edge then sits on line 1.
 */
export const declarationLine = (
  manifest: string,
  key: string,
  kind: "normal" | "build",
): number | undefined => {
  const table = kind === "build" ? "build-dependencies" : "dependencies";
  let current: string | undefined;
  const lines = manifest.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").trim();
      const own = new RegExp(`^(.*)\\.(?:"${key}"|'${key}'|${key})$`).exec(name);
      if (own !== null && DEPENDENCY_TABLE.exec(own[1] ?? "")?.[1] === table) return index + 1;
      current = DEPENDENCY_TABLE.exec(name)?.[1];
      continue;
    }
    if (current !== table) continue;
    const assignment = /^((?:"[^"]*"|'[^']*'|[A-Za-z0-9_-]+))\s*[.=]/.exec(line);
    if (assignment !== null && unquote(assignment[1] ?? "") === key) return index + 1;
  }
  return undefined;
};

const edgesOf = (crate: Crate, text: string | undefined): ReadonlyArray<CrateEdge> =>
  crate.dependencies.flatMap((dependency) => {
    if (dependency.kind === "dev") return [];
    const line =
      (text === undefined ? undefined : declarationLine(text, dependency.key, dependency.kind)) ??
      1;
    const base = { from: crate.manifest, line, written: dependency.key };
    return [
      dependency.member === undefined
        ? { ...base, package: dependency.package }
        : { ...base, to: dependency.member },
    ];
  });

/** Every edge between the workspace's members and out to external crates, by file and line. */
export const crateEdges = (
  workspace: Workspace,
  texts: ReadonlyMap<string, string>,
): ReadonlyArray<CrateEdge> =>
  workspace.members
    .flatMap((crate) => edgesOf(crate, texts.get(crate.manifest)))
    .sort((a, b) => a.from.localeCompare(b.from) || a.line - b.line);
