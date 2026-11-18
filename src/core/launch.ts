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
