/**
 * `mshape dep bump`: moving a dependency on another repo's release tarball, vendored under
 * `vendor/` and recorded in `shape.config.ts` as `files.vendored` (`{ path, package, sha256 }`,
 * verified by the `files` check). The digest comes from the upstream release, never from the
 * tarball in hand, so a tarball that isn't the release is refused; bump never fetches.
 * Planning is pure and refuses before anything is written; the adapter writes, installs and
 * runs the gate.
 */

/** One recorded vendored artifact. */
export interface VendoredEntry {
  readonly path: string;
  readonly package: string;
  readonly sha256: string;
}

export const VENDOR_DIR = "vendor";

const SHA256 = /^[0-9a-f]{64}$/;

export interface BumpInput {
  /** `files.vendored` as the config resolves it. */
  readonly vendored: ReadonlyArray<VendoredEntry>;
  /** The package name to bump, as recorded. */
  readonly name: string;
  /** The new tarball's file name; it is vendored as `vendor/<file>`. */
  readonly file: string;
  /** The `name` in the new tarball's own package.json. */
  readonly tarballPackage: string | undefined;
  /** The new tarball's sha256, computed. */
  readonly actual: string;
  /** The sha256 the upstream release states, from `--sha256`. */
  readonly expected: string;
  readonly packageJson: string;
  readonly configText: string;
}

export interface BumpPlan {
  readonly from: VendoredEntry;
  readonly to: VendoredEntry;
  readonly packageJson: string;
  readonly configText: string;
}

/** A string literal holding exactly `value`, in either quote: what the record's fields are. */
const literal = (value: string): RegExp =>
  new RegExp(`(["'])${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\1`, "g");

const replaceOnce = (
  text: string,
  value: string,
  next: string,
): { text: string } | { count: number } => {
  const count = [...text.matchAll(literal(value))].length;
  if (count !== 1) return { count };
  return { text: text.replace(literal(value), (_, quote: string) => `${quote}${next}${quote}`) };
};

const DEPENDENCY_KEYS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

/** The vendored spec `mshape init --from` and bump write: relative, so every clone resolves it. */
export const vendoredSpecOf = (path: string): string => `file:./${path}`;

/** What bumping `name` to the tarball takes, or every reason it can't: nothing is written then. */
export const planBump = (
  input: BumpInput,
): BumpPlan | { readonly refused: ReadonlyArray<string> } => {
  const refused: Array<string> = [];
  const from = input.vendored.find((entry) => entry.package === input.name);
  if (from === undefined)
    return {
      refused: [
        `no vendored dependency ${input.name} is recorded in shape.config.ts's files.vendored${input.vendored.length > 0 ? ` (recorded: ${input.vendored.map((entry) => entry.package).join(", ")})` : ""}. Record it first: { path: "${VENDOR_DIR}/<tarball>", package: "${input.name}", sha256: "<digest>" }.`,
      ],
    };
  const expected = input.expected.toLowerCase();
  if (!SHA256.test(expected))
    refused.push(
      `--sha256 ${input.expected} is not a sha256: 64 hex digits, from the upstream release.`,
    );
  else if (input.actual !== expected)
    refused.push(
      `the tarball's sha256 is ${input.actual}, but the release says ${expected}: this tarball is not that release. Download it again from the release, or check the digest you were given.`,
    );
  if (input.tarballPackage === undefined)
    refused.push(
      `the tarball has no package/package.json with a name, so it is no package release.`,
    );
  else if (input.tarballPackage !== input.name)
    refused.push(
      `the tarball is the package ${input.tarballPackage}, not ${input.name}. Bump ${input.tarballPackage} only if it is recorded, or check you have the right release.`,
    );
  const to: VendoredEntry = {
    path: `${VENDOR_DIR}/${input.file}`,
    package: input.name,
    sha256: expected,
  };
  if (to.path === from.path && to.sha256 === from.sha256)
    refused.push(`${input.name} is already at ${to.path}, with that digest.`);

  let pkg: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(input.packageJson);
    pkg =
      typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    pkg = undefined;
  }
  const next: Record<string, unknown> = { ...pkg };
  let specs = 0;
  for (const key of DEPENDENCY_KEYS) {
    const deps = pkg?.[key];
    if (typeof deps !== "object" || deps === null) continue;
    const moved = Object.fromEntries(
      Object.entries(deps).map(([dep, spec]) => {
        if (dep !== input.name || spec !== vendoredSpecOf(from.path)) return [dep, spec];
        specs += 1;
        return [dep, vendoredSpecOf(to.path)];
      }),
    );
    next[key] = moved;
  }
  if (pkg === undefined) refused.push("package.json isn't a JSON object.");
  else if (specs === 0)
    refused.push(
      `package.json doesn't depend on ${input.name} as ${vendoredSpecOf(from.path)}, the recorded tarball, so bump can't tell which dependency it is. Make it that spec, then bump again.`,
    );

  let configText = input.configText;
  for (const [field, value, replacement] of [
    ["path", from.path, to.path],
    ["sha256", from.sha256, to.sha256],
  ] as const) {
    if (value === replacement) continue;
    const replaced = replaceOnce(configText, value, replacement);
    if ("text" in replaced) configText = replaced.text;
    else
      refused.push(
        `shape.config.ts has the recorded ${field} "${value}" ${replaced.count === 0 ? "nowhere as a string literal" : `${replaced.count} times`}, so bump can't rewrite it safely. Write it once, as a literal in the files.vendored entry, then bump again.`,
      );
  }
  if (refused.length > 0) return { refused };
  return { from, to, packageJson: `${JSON.stringify(next, null, 2)}\n`, configText };
};
