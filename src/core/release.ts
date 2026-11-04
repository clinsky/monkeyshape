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
  /** Whether the working tree has changes git would commit. */
  readonly dirty: boolean;
}

const nextPatch = (version: string): string => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return match === null ? version : `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
};

/**
 * The version a pack carries: the release's own at its tag; otherwise a prerelease of the next
 * version, naming the commit, which sorts after the release it follows and before the next.
 */
export const packVersion = (source: PackSource): string => {
  if (source.atTag && !source.dirty) return source.version;
  const base = source.tagged ? nextPatch(source.version) : source.version;
  return `${base}-dev.${source.commit}${source.dirty ? ".dirty" : ""}`;
};

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

/** The annotated tag's message: what was packed, and its digest, for a consumer to check. */
export const tagMessage = (name: string, version: string, file: string, sha256: string): string =>
  `${name} ${version}\n\nsha256 ${sha256}  ${file}\n`;
