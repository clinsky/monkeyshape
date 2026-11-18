/**
 * What `mshape init` writes: the package's `template/` files, rendered, plus the JSON configs
 * generated here. The configs are generated rather than copied because they pin versions, and
 * because a `biome.json` inside `template/` would be a nested root config for biome itself.
 * `.claude/settings.json` is rendered from the hook list in `hooks.ts`, and the PR template from
 * `PR_SECTIONS` in `conventions.ts`, the same as this repo's.
 */

import { GATE_SCRIPT, PR_TEMPLATE_FILE, prTemplate } from "./conventions.ts";
import type { VendoredEntry } from "./dep.ts";
import { HOOKS, renderSettings, SETTINGS_FILE } from "./hooks.ts";

/** Lowercase words joined by hyphens: a package name, a directory and a beads prefix at once. */
export const REPO_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** The toolchain a new repo pins: this package's own, so the adopter runs what was tested. */
export interface Toolchain {
  /** Bun's version, for `packageManager` (CI reads it from there). */
  readonly bun: string;
  /** The monkeyshape dependency spec: its exact version, or a tarball when testing a release. */
  readonly monkeyshape: string;
  readonly effect: string;
  readonly biome: string;
  readonly typescript: string;
  readonly typesBun: string;
}

/**
 * Files a package can't carry under their own names: npm drops `.gitignore` from published
 * packages and `bun pm pack` drops `bunfig.toml`, so the template stores them renamed. Any
 * other dotfile ships as is.
 */
const RENAMED: Readonly<Record<string, string>> = {
  gitignore: ".gitignore",
  bunfig: "bunfig.toml",
};

export const targetPath = (templatePath: string): string => RENAMED[templatePath] ?? templatePath;

/**
 * The repo's name as a module name: hyphens to underscores, as Python's packages and Rust's
 * crates spell an identifier (`my-repo` → `my_repo`). `REPO_NAME` leaves nothing else to fix.
 */
export const moduleName = (name: string): string => name.replaceAll("-", "_");

/** `{{name}}` and `{{module}}` filled in: in a file's text, and in its path. */
const render = (text: string, name: string): string =>
  text.replaceAll("{{name}}", name).replaceAll("{{module}}", moduleName(name));

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const configs = (name: string, toolchain: Toolchain): Record<string, string> => ({
  "package.json": json({
    name,
    version: "0.0.0",
    private: true,
    type: "module",
    packageManager: `bun@${toolchain.bun}`,
    scripts: {
      typecheck: "tsc -p .",
      lint: "biome ci --error-on-warnings .",
      fix: "biome check --write .",
      // The npm copy, for this repo's own scripts; hooks and skills run the installed mshape (D-run-mshape).
      mshape: "mshape",
      shape: "mshape check",
      // The gate's stages are the typescript pack's, run by `mshape gate`.
      [GATE_SCRIPT]: "mshape gate",
    },
    dependencies: { effect: toolchain.effect },
    devDependencies: {
      "@biomejs/biome": toolchain.biome,
      "@types/bun": toolchain.typesBun,
      monkeyshape: toolchain.monkeyshape,
      typescript: toolchain.typescript,
    },
  }),
  "tsconfig.json": json({
    extends: "monkeyshape/tsconfig.base.json",
    include: ["src", "test", "*.ts"],
  }),
  "biome.json": json({
    root: true,
    extends: ["monkeyshape/biome"],
    files: { includes: ["src/**", "test/**", "*.json", "*.ts"] },
  }),
});

/** What every pack's repo gets generated: the hooks and the PR template. */
const common = (): Record<string, string> => ({
  [SETTINGS_FILE]: renderSettings(HOOKS),
  [PR_TEMPLATE_FILE]: prTemplate(),
});

/** Where each pack's own template files live, laid over the rest of `template/`. */
export const PACKS_DIR = "packs";

/**
 * The template for one pack: every file of `template/` outside `packs/`, then the pack's own
 * under `packs/<pack>/`, which wins a path both have. Undefined when the package has no
 * template for that pack.
 */
export const templateFor = (
  tree: ReadonlyMap<string, string>,
  pack: string,
): ReadonlyMap<string, string> | undefined => {
  const prefix = `${PACKS_DIR}/${pack}/`;
  const own = [...tree].filter(([path]) => path.startsWith(prefix));
  if (own.length === 0) return undefined;
  return new Map([
    ...[...tree].filter(([path]) => !path.startsWith(`${PACKS_DIR}/`)),
    ...own.map(([path, text]) => [path.slice(prefix.length), text] as const),
  ]);
};

/**
 * Every file of the new repo, by repo-relative path, from `template` (already `templateFor`
 * the pack). TypeScript's JSON configs are generated, and win over the template.
 */
export const scaffold = (
  name: string,
  template: ReadonlyMap<string, string>,
  toolchain: Toolchain,
  vendored?: VendoredEntry,
  pack = "typescript",
  pin?: BornPin,
): ReadonlyMap<string, string> =>
  new Map([
    ...[...template].map(([path, text]) => {
      const rendered = render(text, name);
      const target = render(targetPath(path), name);
      if (target !== CONFIG) return [target, rendered] as const;
      const pinned = pin === undefined ? rendered : recordPin(rendered, pin);
      return [target, vendored === undefined ? pinned : recordVendored(pinned, vendored)] as const;
    }),
    ...(pack === "typescript" ? Object.entries(configs(name, toolchain)) : []),
    ...Object.entries(common()),
  ]);

/** The born repo's config, which every pack's template has. */
export const CONFIG = "shape.toml";

/** The `mshape` a born repo pins: the version it runs, and its release's sums when known. */
export interface BornPin {
  readonly version: string;
  /** The sha256 of the release's `SHA256SUMS`; absent for a build no release verified. */
  readonly sums?: string | undefined;
}

/** The `[mshape]` table for `pin`, as init writes it. */
export const pinTable = (pin: BornPin): string =>
  [
    "# The mshape this repo runs: an installed mshape elsewhere fetches and verifies this one.",
    "[mshape]",
    `version = ${JSON.stringify(pin.version)}`,
    ...(pin.sums === undefined ? [] : [`sums = ${JSON.stringify(pin.sums)}`]),
    "",
  ].join("\n");

/**
 * A config with `pin` as its `[mshape]` table, before its first table so it reads near the
 * top, or at the end of a config with no table.
 */
export const recordPin = (config: string, pin: BornPin): string => {
  // The first table header, with the comment lines directly above it.
  const at = config.search(/^(?:#[^\n]*\n)*\[/mu);
  return at === -1
    ? `${config}${config.endsWith("\n\n") ? "" : "\n"}${pinTable(pin)}`
    : `${config.slice(0, at)}${pinTable(pin)}\n${config.slice(at)}`;
};

/**
 * A config with `entry` recorded as its one vendored artifact, as a `[files]` table at the
 * end: how a repo born from a tarball passes the files check on its first gate.
 */
export const recordVendored = (config: string, entry: VendoredEntry): string =>
  `${config}${config.endsWith("\n") ? "" : "\n"}
# Release tarballs under vendor/, each with its package name and the sha256 its release
# states: the files check verifies them. Move one with \`mshape dep bump\`.
[files]
vendored = [
  { path = ${JSON.stringify(entry.path)}, package = ${JSON.stringify(entry.package)}, sha256 = ${JSON.stringify(entry.sha256)} },
]
`;

/**
 * Shares a repo's beads through git origin, run once after the first push: the beads go to
 * origin's `refs/dolt/data`, where a second clone's `bd bootstrap` finds them, and the
 * committed `dolt.auto-push` makes every clone push its writes (at most every five minutes).
 * Printed, never run: it publishes the repo's issue history to that remote.
 */
export const SHARE_BEADS =
  "bd dolt push --yes && bd config set dolt.auto-push true && git commit --quiet -m 'Share beads through origin' .beads/config.yaml && git push --quiet origin HEAD";

/** The last thing `init` prints: what to do now, and where the conventions are. */
export const nextStep = (name: string, workflowUrl: string): string =>
  [
    "Next:",
    `1. Give it a GitHub remote, since agents push and open PRs: in ${name}/ run`,
    `   \`gh repo create ${name} --private --source . --push\` (or add a remote and push main).`,
    "2. Share its beads through that remote, so another clone's `bd bootstrap` gets them. This",
    `   publishes the issue history there: \`${SHARE_BEADS}\``,
    `3. Open a chat with your coding agent in ${name}/ and run /roadmap with a brain-dump of`,
    "   what you want to build. It writes docs/roadmap.md and the first epics, and opens a PR.",
    `The working loop, in full: ${workflowUrl}`,
  ].join("\n");
