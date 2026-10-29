/**
 * What `mshape init` writes: the package's `template/` files, rendered, plus the JSON configs
 * generated here. The configs are generated rather than copied because they pin versions, and
 * because a `biome.json` inside `template/` would be a nested root config for biome itself.
 */

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
 * npm drops `.gitignore` from published packages, so the template stores it without the dot.
 * Any other dotfile ships as is.
 */
const RENAMED: Readonly<Record<string, string>> = { gitignore: ".gitignore" };

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
      shape: "mshape check",
      check: "bun run typecheck && bun run lint && bun run shape && bun test --pass-with-no-tests",
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

/** Every file of the new repo, by repo-relative path. Generated configs win over the template. */
export const scaffold = (
  name: string,
  template: ReadonlyMap<string, string>,
  toolchain: Toolchain,
): ReadonlyMap<string, string> =>
  new Map([
    ...[...template].map(([path, text]) => [targetPath(path), render(text, name)] as const),
    ...Object.entries(configs(name, toolchain)),
  ]);

/** The last thing `init` prints: what to do now, and where the conventions are. */
export const nextStep = (name: string, workflowUrl: string): string =>
  [
    `Next: open a chat with your coding agent in ${name}/ and run /roadmap with a brain-dump of`,
    "what you want to build. It writes docs/roadmap.md and the first epics.",
    `The working loop, in full: ${workflowUrl}`,
  ].join("\n");
