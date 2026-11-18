/**
 * A Cargo workspace as `cargo metadata --no-deps --format-version 1` describes it, with paths
 * made relative to the workspace root, which is the repo root (the pack runs cargo there).
 * `--no-deps` reads only the manifests: no network, no lockfile resolution, so it is fast and
 * works offline. Pure: it reads the JSON text the loader recorded.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

const Dependency = Schema.Struct({
  name: Schema.String,
  rename: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(Schema.Literals(["dev", "build"])),
  path: Schema.optionalKey(Schema.String),
});

const Target = Schema.Struct({
  name: Schema.String,
  kind: Schema.Array(Schema.String),
  src_path: Schema.String,
});

const Package = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  manifest_path: Schema.String,
  targets: Schema.Array(Target),
  dependencies: Schema.Array(Dependency),
});

const Metadata = Schema.Struct({
  workspace_root: Schema.String,
  workspace_members: Schema.Array(Schema.String),
  packages: Schema.Array(Package),
});

// cargo metadata adds fields in minor releases; the pack reads the subset above, so a key it
// doesn't know is not an error.
// shape-ignore decode-strict: cargo's JSON is a versioned external format that grows
const decode = Schema.decodeUnknownResult(Metadata, { onExcessProperty: "ignore" });

/** What a target is to cargo: its first kind. `custom-build` is a build script. */
export type TargetKind = "lib" | "bin" | "test" | "bench" | "example" | "custom-build" | "other";

export interface CrateTarget {
  readonly name: string;
  readonly kind: TargetKind;
  /** Its root file, repo-relative. */
  readonly root: string;
}

/** A dependency as the member's manifest declares it. */
export interface CrateDependency {
  /** The package's name: what `packages` allowlists. */
  readonly package: string;
  /** The key the manifest writes it under: the rename, else the name. */
  readonly key: string;
  readonly kind: "normal" | "dev" | "build";
  /** The member's manifest, when the dependency is another member of the workspace. */
  readonly member: string | undefined;
}

export interface Crate {
  readonly name: string;
  /** Its `Cargo.toml`, repo-relative. */
  readonly manifest: string;
  /** Its directory, repo-relative; `""` for a crate at the root. */
  readonly directory: string;
  readonly targets: ReadonlyArray<CrateTarget>;
  readonly dependencies: ReadonlyArray<CrateDependency>;
}

export interface Workspace {
  /** The workspace's members, by manifest path. */
  readonly members: ReadonlyArray<Crate>;
}

const TARGET_KINDS: ReadonlySet<string> = new Set([
  "lib",
  "bin",
  "test",
  "bench",
  "example",
  "custom-build",
]);

/** cargo's kinds for a library: `lib`, `rlib`, `cdylib`, `proc-macro` and the rest. */
const LIBRARY_KINDS: ReadonlySet<string> = new Set([
  "rlib",
  "dylib",
  "cdylib",
  "staticlib",
  "proc-macro",
]);

const targetKind = (kinds: ReadonlyArray<string>): TargetKind => {
  const first = kinds[0] ?? "";
  if (TARGET_KINDS.has(first)) return first as TargetKind;
  return LIBRARY_KINDS.has(first) ? "lib" : "other";
};

/** `path` relative to `root`, or undefined when it is outside it. */
const relative = (root: string, path: string): string | undefined => {
  const base = root.endsWith("/") ? root : `${root}/`;
  if (path === root) return "";
  return path.startsWith(base) ? path.slice(base.length) : undefined;
};

const directoryOf = (manifest: string): string =>
  manifest.includes("/") ? manifest.slice(0, manifest.lastIndexOf("/")) : "";

/**
 * The workspace in `json`, or why it can't be read. A package outside the workspace root
 * (cargo lists only members with `--no-deps`, but a path could still escape) is skipped.
 */
export const workspaceOf = (json: string): Result.Result<Workspace, string> => {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return Result.fail(`cargo metadata printed no JSON: ${String(error)}`);
  }
  const decoded = decode(raw);
  if (Result.isFailure(decoded))
    return Result.fail(`cargo metadata's JSON isn't what the Rust pack reads: ${decoded.failure}`);
  const metadata = decoded.success;
  const root = metadata.workspace_root;
  const memberIds = new Set(metadata.workspace_members);
  const packages = metadata.packages.filter((pkg) => memberIds.has(pkg.id));
  const byDirectory = new Map<string, string>();
  for (const pkg of packages) {
    const manifest = relative(root, pkg.manifest_path);
    if (manifest !== undefined) byDirectory.set(directoryOf(manifest), manifest);
  }
  const members: Array<Crate> = [];
  for (const pkg of packages) {
    const manifest = relative(root, pkg.manifest_path);
    if (manifest === undefined) continue;
    const targets: Array<CrateTarget> = [];
    for (const target of pkg.targets) {
      const file = relative(root, target.src_path);
      if (file !== undefined)
        targets.push({ name: target.name, kind: targetKind(target.kind), root: file });
    }
    members.push({
      name: pkg.name,
      manifest,
      directory: directoryOf(manifest),
      targets,
      dependencies: pkg.dependencies.map((dependency) => {
        const directory =
          dependency.path === undefined ? undefined : relative(root, dependency.path);
        return {
          package: dependency.name,
          key: dependency.rename ?? dependency.name,
          kind: dependency.kind ?? "normal",
          member: directory === undefined ? undefined : byDirectory.get(directory),
        };
      }),
    });
  }
  members.sort((a, b) => a.manifest.localeCompare(b.manifest));
  return Result.succeed({ members });
};
