/**
 * Where `mshape` keeps what it fetches or unpacks: one cache per machine, shared by every
 * version, repo and track worktree, under `$XDG_CACHE_HOME` as uv's and rustup's are.
 */

/** The environment the cache's place depends on. */
export interface CacheEnv {
  readonly XDG_CACHE_HOME?: string | undefined;
  readonly HOME?: string | undefined;
}

/** `$XDG_CACHE_HOME/monkeyshape`, else `$HOME/.cache/monkeyshape`; `fallback` with neither. */
export const cacheRoot = (env: CacheEnv, fallback: string): string => {
  const xdg = env.XDG_CACHE_HOME ?? "";
  const home = env.HOME ?? "";
  const base = xdg !== "" ? xdg : home !== "" ? `${home}/.cache` : fallback;
  return `${base.replace(/\/$/, "")}/monkeyshape`;
};

/** Where version `version`'s embedded files are unpacked: one directory per build. */
export const unpackedDir = (cache: string, version: string, digest: string): string =>
  `${cache}/${version}/package-${digest}`;

/** A repo's pin of `mshape`, as `shape.toml`'s `[mshape]` holds it. */
export interface Pin {
  readonly version: string;
  /** The sha256 of the release's `SHA256SUMS`. */
  readonly sums?: string | undefined;
  /** An argv to run instead: monkeyshape's own repo, from source. */
  readonly dev?: ReadonlyArray<string> | undefined;
}

/** The `mshape` deciding: its version, and the `SHA256SUMS` digest recorded beside it. */
export interface Running {
  readonly version: string;
  /** Written by `install.sh` or by the launcher's fetch; undefined for any other copy. */
  readonly recordedSums: string | undefined;
}

/** What the launcher does with a command. */
export type LaunchPlan =
  | { readonly kind: "self" }
  | { readonly kind: "dev"; readonly argv: ReadonlyArray<string> }
  | { readonly kind: "pinned"; readonly version: string; readonly sums: string }
  | { readonly kind: "refuse"; readonly message: string };

/**
 * The environment variable a launched `mshape` gets: the version launched (`dev` for a `dev`
 * argv), so that one runs itself and never relaunches. Every process it starts inherits it, so
 * it is honoured only by the `mshape` it names (`launchedHere`): a nested `mshape`, a gate
 * stage's or `track pr`'s, is the installed launcher again and follows the pin.
 */
export const LAUNCHED_ENV = "MSHAPE_LAUNCHED";

/** What `install.sh` sets to run the copy it just installed, wherever its cwd is. */
export const INSTALL_MARKER = "install";

/** Whether `LAUNCHED_ENV`'s `value` names the running `mshape`, `version`. */
export const launchedHere = (value: string | undefined, version: string): boolean =>
  value === version || value === INSTALL_MARKER;

/**
 * What the installed `mshape` does inside a repo, as rustup honours `rust-toolchain.toml`: the
 * repo is held to its pin, and the installed copy is only the launcher. `launched` is set in a
 * copy this launcher started, which runs itself whatever the pin says.
 */
export const launchPlan = (
  pin: Pin | undefined,
  running: Running,
  launched: boolean,
): LaunchPlan => {
  if (launched || pin === undefined) return { kind: "self" };
  if (pin.dev !== undefined) return { kind: "dev", argv: pin.dev };
  if (pin.version === running.version) {
    if (pin.sums === undefined || pin.sums === running.recordedSums) return { kind: "self" };
    return {
      kind: "refuse",
      message: `shape.toml pins mshape ${pin.version} with SHA256SUMS sha256 ${pin.sums}, but this mshape ${running.version} ${running.recordedSums === undefined ? "has no SHA256SUMS digest recorded beside it (install.sh records one)" : `was installed from SHA256SUMS sha256 ${running.recordedSums}`}. Reinstall it with \`curl -fsSL ${INSTALL_URL} | MSHAPE_VERSION=${pin.version} sh\`, or fix the pin's sums`,
    };
  }
  if (pin.sums === undefined)
    return {
      kind: "refuse",
      message: `shape.toml pins mshape ${pin.version} with no sums, so a download of it can't be verified, and this mshape is ${running.version}. Add \`sums\`, the sha256 of v${pin.version}'s SHA256SUMS (its release tag's message records it), under [mshape]`,
    };
  return { kind: "pinned", version: pin.version, sums: pin.sums };
};

/** Where every release's assets are, `<RELEASES>/download/v<version>/<asset>`. */
export const RELEASES_URL = "https://github.com/clinsky/monkeyshape/releases";

/** The one install line, in every message that tells someone to install `mshape`. */
export const INSTALL_URL = `${RELEASES_URL}/latest/download/install.sh`;

/** An asset of release `version`, under `releases` (a mirror's, or `RELEASES_URL`). */
export const assetUrl = (releases: string, version: string, asset: string): string =>
  `${releases.replace(/\/$/, "")}/download/v${version}/${asset}`;

/** The sha256 `SHA256SUMS` lists for `file`; undefined when it lists none. */
export const listedDigest = (sums: string, file: string): string | undefined => {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line.trim());
    if (match?.[2] === file) return match[1];
  }
  return undefined;
};
