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

const render = (text: string, name: string): string => text.replaceAll("{{name}}", name);

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
      // How hooks and skills run mshape: D-run-mshape.
      mshape: "mshape",
      shape: "mshape check",
      [GATE_SCRIPT]:
        "bun run typecheck && bun run lint && bun run shape && bun test --pass-with-no-tests",
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
  [SETTINGS_FILE]: renderSettings(HOOKS),
  [PR_TEMPLATE_FILE]: prTemplate(),
});

/** Every file of the new repo, by repo-relative path. Generated configs win over the template. */
export const scaffold = (
  name: string,
  template: ReadonlyMap<string, string>,
  toolchain: Toolchain,
  vendored?: VendoredEntry,
): ReadonlyMap<string, string> =>
  new Map([
    ...[...template].map(([path, text]) => {
      const rendered = render(text, name);
      const target = targetPath(path);
      return [
        target,
        target === CONFIG && vendored !== undefined ? recordVendored(rendered, vendored) : rendered,
      ] as const;
    }),
    ...Object.entries(configs(name, toolchain)),
  ]);

const CONFIG = "shape.config.ts";

/**
 * A config with `entry` recorded as its one vendored artifact, before the closing `});` of
 * `defineConfig`: how a repo born from a tarball passes the files check on its first gate.
 */
export const recordVendored = (config: string, entry: VendoredEntry): string => {
  const end = config.lastIndexOf("});");
  // A template without it gets no record; test/integration/init.test.ts asserts it lands.
  if (end === -1) return config;
  const block = `  files: {
    // Release tarballs under vendor/, each with its package name and the sha256 its release
    // states: the files check verifies them. Move one with \`mshape dep bump\`.
    vendored: [
      { path: ${JSON.stringify(entry.path)}, package: ${JSON.stringify(entry.package)}, sha256: ${JSON.stringify(entry.sha256)} },
    ],
  },
`;
  return `${config.slice(0, end)}${block}${config.slice(end)}`;
};

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
