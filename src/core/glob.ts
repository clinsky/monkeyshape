/** Glob matching with compiled patterns cached; `Bun.Glob` is pure string matching. */
const cache = new Map<string, Bun.Glob>();

const compiled = (pattern: string): Bun.Glob => {
  let glob = cache.get(pattern);
  if (glob === undefined) {
    glob = new Bun.Glob(pattern);
    cache.set(pattern, glob);
  }
  return glob;
};

export const matches = (path: string, pattern: string): boolean => compiled(pattern).match(path);

export const matchesAny = (path: string, patterns: ReadonlyArray<string>): boolean =>
  patterns.some((pattern) => matches(path, pattern));

/** A pattern naming a directory also matches everything below it (`dist` ≡ `dist/**`). */
export const matchesPathOrBelow = (path: string, pattern: string): boolean => {
  const trimmed = pattern.replace(/^\.\//, "").replace(/\/$/, "");
  return matches(path, trimmed) || path.startsWith(`${trimmed}/`) || matches(path, `${trimmed}/**`);
};
