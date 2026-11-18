/**
 * The tools `mshape` delivers itself, pinned inside it: a repo pins only `mshape`, and each
 * `mshape` version carries one version of each tool and the sha256 of its download for every
 * platform it runs on. Fetched into the machine's cache on first use and verified there.
 */

/** The machines `mshape` runs on, as `<os>-<arch>`: the release's binaries and every tool. */
export const PLATFORMS = ["linux-x64", "linux-arm64", "darwin-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** `process.platform` and `process.arch` as a supported platform; undefined when it isn't one. */
export const platformOf = (os: string, arch: string): Platform | undefined =>
  PLATFORMS.find((platform) => platform === `${os}-${arch}`);

/** Why `os-arch` gets no binary or tool, naming the supported ones. */
export const unsupportedPlatform = (os: string, arch: string): string =>
  `${os}-${arch} is not a platform mshape supports: it runs on ${PLATFORMS.join(", ")}`;

/** One tool's download for one platform: a gzipped tarball holding the executable. */
export interface ToolDownload {
  readonly url: string;
  readonly sha256: string;
}

/** A tool as `mshape` pins it. */
export interface ToolPin {
  readonly name: string;
  readonly version: string;
  /** The executable's path inside the tarball. */
  readonly executable: string;
  readonly downloads: Readonly<Record<Platform, ToolDownload>>;
}

const astGrepDownload = (suffix: string, version: string, sha256: string): ToolDownload => ({
  url: `https://registry.npmjs.org/@ast-grep/cli-${suffix}/-/cli-${suffix}-${version}.tgz`,
  sha256,
});

/**
 * ast-grep, which runs a repo's own rules (`shape-rules/`) in every language: its npm
 * per-platform packages, whose sha256 were taken from tarballs that matched npm's own sha512
 * integrity when pinned. A new version is a new pin here, in a PR.
 */
export const AST_GREP: ToolPin = {
  name: "ast-grep",
  version: "0.51.1",
  executable: "package/ast-grep",
  downloads: {
    "linux-x64": astGrepDownload(
      "linux-x64-gnu",
      "0.51.1",
      "617128eff67d49d709ded54d9c089371d882ce11628c6d79c00add00aa38cb3c",
    ),
    "linux-arm64": astGrepDownload(
      "linux-arm64-gnu",
      "0.51.1",
      "1b68729c99bf026f5b8deec3ebd52f2f721a157a45bb4375c61ca5acaaad13d5",
    ),
    "darwin-arm64": astGrepDownload(
      "darwin-arm64",
      "0.51.1",
      "9d2c21843cebaa11afff8a249703b04a764ef1e03c9f795447e83bec5e34230b",
    ),
  },
};

/** Where a verified copy of `pin` lives in the cache: one directory per tool and version. */
export const toolDir = (cache: string, pin: ToolPin): string =>
  `${cache}/tools/${pin.name}/${pin.version}`;

/** Why a download is refused: it isn't the file the pin names. */
export const hashMismatch = (pin: ToolPin, url: string, expected: string, got: string): string =>
  `${pin.name} ${pin.version} from ${url} has sha256 ${got}, but mshape pins ${expected}: refused and deleted, never run. Retry; if it persists, the download was tampered with or the pin is wrong`;
