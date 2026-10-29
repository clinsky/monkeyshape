/** POSIX path helpers for repo-relative paths. Kept here so core needs no host module. */

export const dirname = (path: string): string => {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
};

/** Joins and normalizes; a result escaping the root keeps its leading `..` segments. */
export const join = (...parts: ReadonlyArray<string>): string => {
  const out: Array<string> = [];
  for (const segment of parts.join("/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
};

export const basename = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
