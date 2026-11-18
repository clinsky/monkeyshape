/**
 * What a release is: the tarball packed from the commit its tag `v<version>` names, never from
 * a working tree. Any other pack is a development build, and its version says so: it never
 * claims a released number, since `mshape init` stamps the version into every repo it makes.
 */

export const releaseTag = (version: string): string => `v${version}`;

/** What the version of a pack depends on. */
export interface PackSource {
  /** `package.json`'s version. */
  readonly version: string;
  /** Whether the tag `v<version>` exists: that version has been released. */
  readonly tagged: boolean;
  /** Whether HEAD is the tagged commit and the tree has no changes: this is the release. */
  readonly atTag: boolean;
  /** HEAD's short commit id. */
  readonly commit: string;
  /** Whether what the package ships differs from HEAD: changed, staged or untracked files. */
  readonly dirty: boolean;
}

const nextPatch = (version: string): string => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? version : `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
};

/**
 * The version a pack carries: the release's own at its tag; otherwise a prerelease naming the
 * commit. Past a tagged release it is of the next patch, so it sorts after the release it
 * follows. Without the tag it is of `version` itself, which sorts before it: right for a
 * version not yet released, wrong where the tag exists elsewhere but isn't here, which is why
 * `untaggedWarning` says so.
 */
export const packVersion = (source: PackSource): string => {
  if (source.atTag && !source.dirty) return source.version;
  const base = source.tagged ? nextPatch(source.version) : source.version;
  return `${base}-dev.${source.commit}${source.dirty ? ".dirty" : ""}`;
};

/** What `pack` says when it can't tell a released version from one to come; else nothing. */
export const untaggedWarning = (source: PackSource): string | undefined =>
  source.tagged
    ? undefined
    : `no tag ${releaseTag(source.version)} here, so this pack is ${packVersion(source)}, which sorts before ${source.version}. If ${source.version} is released, run \`git fetch --tags\` and pack again.`;

/** A tarball as a release compares them: its version, and each file's content digest. */
export interface Tarball {
  readonly version: string;
  /** Path inside the tarball to the sha256 of its content. */
  readonly files: ReadonlyMap<string, string>;
}

/**
 * How `packed` differs from `published`, one line each; none when they hold the same files
 * with the same content. Compression bytes aren't compared: they vary with the packer.
 */
export const tarballDifferences = (packed: Tarball, published: Tarball): ReadonlyArray<string> => {
  const out: Array<string> = [];
  if (packed.version !== published.version)
    out.push(`version: packed ${packed.version}, published ${published.version}`);
  for (const [file, digest] of [...packed.files].sort(([a], [b]) => a.localeCompare(b))) {
    const theirs = published.files.get(file);
    if (theirs === undefined) out.push(`only in the packed tarball: ${file}`);
    else if (theirs !== digest) out.push(`content differs: ${file}`);
  }
  for (const file of [...published.files.keys()].sort())
    if (!packed.files.has(file)) out.push(`only in the published tarball: ${file}`);
  return out;
};

/**
 * The annotated tag's message: what was released, each file with its digest, for a consumer
 * to check. `SHA256SUMS`' digest is the `sums` a repo's pin of this version holds.
 */
export const tagMessage = (
  name: string,
  version: string,
  digests: ReadonlyArray<readonly [file: string, sha256: string]>,
): string =>
  `${name} ${version}\n\n${digests.map(([file, digest]) => `sha256 ${digest}  ${file}\n`).join("")}`;

/**
 * A machine the compiled `mshape` runs on: the release asset's name, Bun's compile target, and
 * the oxc-parser native binding it embeds. Linux builds are glibc's; x64 is Bun's baseline
 * build, which runs on CPUs without AVX2.
 */
export interface BinaryTarget {
  /** `<os>-<arch>`, as `install.sh` and the launcher name a machine. */
  readonly platform: string;
  readonly bunTarget: string;
  /** The suffix of `@oxc-parser/binding-<suffix>` and its `parser.<suffix>.node`. */
  readonly oxcBinding: string;
}

export const BINARY_TARGETS: ReadonlyArray<BinaryTarget> = [
  { platform: "linux-x64", bunTarget: "bun-linux-x64-baseline", oxcBinding: "linux-x64-gnu" },
  { platform: "linux-arm64", bunTarget: "bun-linux-arm64", oxcBinding: "linux-arm64-gnu" },
  { platform: "darwin-arm64", bunTarget: "bun-darwin-arm64", oxcBinding: "darwin-arm64" },
];

/** The release asset holding `target`'s binary. */
export const binaryAsset = (target: BinaryTarget): string => `mshape-${target.platform}`;

/** The release asset listing every binary's sha256, the file a repo's pin hashes. */
export const SUMS_FILE = "SHA256SUMS";

/** `SHA256SUMS` in the format `sha256sum --check` reads, sorted by file. */
export const sha256Sums = (digests: ReadonlyMap<string, string>): string =>
  [...digests]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, digest]) => `${digest}  ${file}\n`)
    .join("");

/**
 * `name`'s pinned version and integrity in a `bun.lock`'s text; undefined when the lock has no
 * entry for it. An optional dependency for another platform is in the lock though not
 * installed, which is how a release fetches the other platforms' bindings verified.
 */
export const lockedPackage = (
  lock: string,
  name: string,
): { readonly version: string; readonly integrity: string } | undefined => {
  const quoted = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = new RegExp(
    `"${quoted}": \\["${quoted}@([^"]+)", "[^"]*", \\{[^}]*\\}, "(sha512-[^"]+)"\\]`,
  ).exec(lock);
  return match?.[1] === undefined || match[2] === undefined
    ? undefined
    : { version: match[1], integrity: match[2] };
};

/** A file the binary embeds: its path in the package, and where the build reads it. */
export interface EmbeddedFile {
  readonly path: string;
  readonly source: string;
}

/**
 * The compiled binary's entry module: it embeds each file, then hands them to `start` (the
 * module at `startModule`) with the package's version and a digest of its files, which names
 * the directory they are unpacked into.
 */
export const binaryEntry = (
  files: ReadonlyArray<EmbeddedFile>,
  startModule: string,
  version: string,
  digest: string,
): string =>
  [
    `import { start } from ${JSON.stringify(startModule)};`,
    ...files.map(
      (file, index) =>
        `import file${index} from ${JSON.stringify(file.source)} with { type: "file" };`,
    ),
    "const files = {",
    ...files.map((file, index) => `  ${JSON.stringify(file.path)}: file${index},`),
    "};",
    `await start(files, ${JSON.stringify(version)}, ${JSON.stringify(digest)});`,
    "",
  ].join("\n");

/** Where oxc-parser's `bindings.js`, generated by napi-rs, stops picking a binding. */
export const OXC_LOADER = "if (!nativeBinding) {";
const CREATE_REQUIRE = /const require = createRequire\(import\.meta\.url\);?/g;

/**
 * An oxc-parser file as the binary bundles it. oxc loads modules lazily through
 * `createRequire(import.meta.url)`, which the bundler can't follow: without it, each `require`
 * is the bundle's own, resolved when built. `bindings.js` becomes the `binding` the binary
 * embeds and oxc's own exports of it, with none of the code that picks one at run time;
 * undefined when it no longer has `OXC_LOADER`'s block before its exports.
 */
export const oxcForBinary = (path: string, text: string, binding: string): string | undefined => {
  const bundled = text.replace(CREATE_REQUIRE, "");
  if (!/[\\/]bindings\.js$/.test(path)) return bundled;
  const loader = bundled.lastIndexOf(OXC_LOADER);
  const exports = loader === -1 ? -1 : bundled.indexOf("\n}\n", loader);
  if (exports === -1) return undefined;
  return [
    `const nativeBinding = require(${JSON.stringify(binding)});`,
    `const __napiLoadedBindingTarget = "native";`,
    bundled.slice(exports + 3),
  ].join("\n");
};
