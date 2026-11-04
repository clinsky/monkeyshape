/**
 * What the repo holds, whatever the language: no file past the size cap without a reason, no
 * `.env` file, and each vendored release tarball the one its record says. Large data lives
 * outside the repo (`tracks.sharedPaths`), and secrets never enter it.
 *
 * Files another tool owns (`classify`'s `builtin`: `.beads/`, git's own files, symlinks)
 * are not held to any of it.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { matchesPathOrBelow } from "./glob.ts";
import { classify, type Snapshot, type Violation } from "./model.ts";

/** Every rule this check reports, as `files/<kind>`; test/core/ruleCases.test.ts covers each. */
export const FILES_RULES = [
  "too-large",
  "large-unmatched",
  "env",
  "vendored-missing",
  "vendored-digest",
  "vendored-package",
] as const;

const CONFIG_FILE = "shape.config.ts";

const violation = (
  rule: (typeof FILES_RULES)[number],
  file: string,
  message: string,
): Violation => ({ check: "files", rule: `files/${rule}`, file, message });

/** `.env` and `.env.<anything>`. */
const ENV_FILE = /^\.env(\.[^/]+)?$/;

/** A template holds no secret. Judged by the name's last segment, so `.env.local.example` is one. */
const ENV_TEMPLATE = /\.(example|sample|template)$/;

/** What a release tarball looks like. */
const ARCHIVE = /\.(tgz|tar\.gz)$/;

/** In the largest unit that keeps it readable, so a small cap still says how far past it is. */
export const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
    : bytes >= 1024
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : `${bytes} bytes`;

/** The files this check holds: everything but what another tool owns. */
export const heldFiles = (snapshot: Snapshot): ReadonlyArray<string> =>
  snapshot.files.filter((file) => classify(file, snapshot.modes.get(file)) !== "builtin");

export const checkFiles = (
  config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const out: Array<Violation> = [];
  const { maxBytes, large, vendored } = config.files;
  const held = heldFiles(snapshot);
  const recorded = new Set(vendored.map((entry) => entry.path));

  for (const file of held) {
    const size = snapshot.sizes.get(file) ?? 0;
    if (
      size > maxBytes &&
      !recorded.has(file) &&
      !large.some((entry) => matchesPathOrBelow(file, entry.path))
    )
      out.push(
        violation(
          "too-large",
          file,
          `is ${formatBytes(size)}, past the ${formatBytes(maxBytes)} cap. ${
            file.startsWith("vendor/") && ARCHIVE.test(file)
              ? `If it is a vendored release, record it in \`files.vendored\` in ${CONFIG_FILE} (\`{ path, package, sha256 }\`, with the digest from its upstream release), which exempts it from the cap. Otherwise keep it outside the repo.`
              : `Keep large data outside the repo (\`tracks.sharedPaths\` links it into worktrees); if it must be tracked, list it in \`files.large\` in ${CONFIG_FILE} with the reason.`
          }`,
        ),
      );
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name))
      out.push(
        violation(
          "env",
          file,
          "is an environment file, which holds secrets and must never be tracked. Remove it from the index (`git rm --cached`), add `.env*` to .gitignore followed by `!.env.example` (or your template's name) so templates stay tracked, and rotate anything it held if it was ever pushed. A template without secrets ends in `.example`, `.sample` or `.template`.",
        ),
      );
  }

  for (const entry of large)
    if (!held.some((file) => matchesPathOrBelow(file, entry.path)))
      out.push(
        violation(
          "large-unmatched",
          CONFIG_FILE,
          `\`files.large\` lists '${entry.path}', which matches no file. Remove the entry, or fix its glob.`,
        ),
      );

  const present = new Set(snapshot.files);
  for (const entry of vendored) {
    const read = snapshot.vendored.get(entry.path);
    if (!present.has(entry.path) || read === undefined) {
      out.push(
        violation(
          "vendored-missing",
          CONFIG_FILE,
          `\`files.vendored\` records '${entry.path}', which is not in the repo. Commit the tarball, or fix or remove the record.`,
        ),
      );
      continue;
    }
    if (read.sha256 !== entry.sha256)
      out.push(
        violation(
          "vendored-digest",
          entry.path,
          `has sha256 ${read.sha256}, but \`files.vendored\` records ${entry.sha256}. The file changed since it was recorded: restore the release's tarball, or, if this is a new release, check its digest against the upstream release before recording it.`,
        ),
      );
    if ("unreadable" in read.package)
      out.push(
        violation(
          "vendored-package",
          entry.path,
          `is recorded as ${entry.package}, but its package name can't be read: ${read.package.unreadable}. A vendored artifact is an npm release tarball, with a package/package.json inside.`,
        ),
      );
    else if (read.package.name !== entry.package)
      out.push(
        violation(
          "vendored-package",
          entry.path,
          `holds package ${read.package.name}, but \`files.vendored\` records ${entry.package}. Fix the record, or vendor the right release.`,
        ),
      );
  }
  return out;
};
