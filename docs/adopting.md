# Adding monkeyshape to an existing repo

A new repo should start with `mshape init` (see the README). This guide is for a repo that
already exists. Follow it in order: each step leaves the repo working.

Nothing here is deleted to fit a budget or silence a check. Whatever you don't fix today is
grandfathered by the baseline in step 7, and from then on its count can only go down. The
tests build a repo from exactly the file blocks below and run its gate.

## 1. Install, pinned

Add only the packages you don't already have, at exact versions:

```sh
bun add -d --exact monkeyshape effect @biomejs/biome typescript @types/bun
```

Leave out any you already depend on. Re-adding a package rewrites its pinned version as a
range. monkeyshape runs on Bun. It asks your `tsc` and `biome` which files they cover, and
`effect` is its peer dependency.

To install monkeyshape from a release tarball rather than npm, put the tarball under
`vendor/` and run `bun add -d --exact ./vendor/<tarball>`. Then record it as step 3 shows.

Add the script that hooks and skills run, to `package.json`'s `scripts`:
`"mshape": "mshape"`. Every command below is `bun run --silent mshape <command>`.

## 2. Try it first

Before changing the repo, write a config somewhere else and point at it:

```sh
bun run --silent mshape check --config ../trial/shape.config.ts
```

Start from `export default defineConfig({});`, with `defineConfig` imported from
`monkeyshape`. The report names each check, says what it examined, and explains every
finding. The config's imports resolve from the repo, wherever the file is.

## 3. shape.config.ts

For a repo whose code is under `src/`:

```ts
// shape.config.ts
import { defineConfig } from "monkeyshape";

export default defineConfig({
  arch: {
    modules: {
      core: { description: "Deterministic logic. No host I/O." },
      // optional: no adapter code yet. A module that matches no file fails unless optional.
      adapters: {
        description: "Host I/O behind services.",
        mayImport: ["core"],
        hostAccess: true,
        optional: true,
      },
    },
  },
});
```

Each check reads its own part of the config.

- **`sources`** lists the TypeScript the rules analyze. The default is `src/**` and `tools/**`.
  Every other TypeScript file must be a test, a `.d.ts`, or under `sources.exempt` with a
  reason, or the `sources` check fails. Code spread over top-level directories is listed in
  `sources: { include: ["*.ts", "lib/**/*.ts", "scripts/**/*.ts"] }`.
- **`arch`** is the module map. Every file in `sources` must belong to a module. With code
  outside `src/`, set `arch.root: "."`. A module's key is then its directory (`lib`) or a single
  file (`main.ts`). A directory such as `tools/` that matches no module fails as
  `arch/unknown-module`: give it a module, or narrow `sources`.
- **Packages.** A module may import `effect` and the packages in `arch.allowedPackages`. One
  module's own extra packages go in its `packages`. `hostAccess: true` lets a module use
  `node:*`, `Bun` and the like.
- **`entry`** lists the files that run things: the clock, the environment and console output
  are allowed there.
- **Other languages are covered, never analyzed.**
  - Executable source that isn't TypeScript needs a command that checks it. That includes C,
    Python, shell, Java and Go, or any file with git's executable bit.
  - Declare it as `coverage: { commands: [{ files: ["native/**"], run: ["make", "-C", "native", "check"] }] }`.
    `run` is argv, not a shell line. Make it write nothing into the tree: for Python,
    `["python3", "-c", "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]", "<files>"]`,
    not `py_compile`.
  - `optional: true` turns a missing program into a note. A program that runs and fails is red.
  - A file no command can check here, such as a test fixture or a plugin compiled by another
    tool, goes in `coverage.exemptFiles` as `{ path, reason }`.
  - The executable bit is only a heuristic. A script with an unusual extension and no bit
    still needs a command or an exemption.
- **Vendored tarballs** are recorded with the digest their release states:
  `files: { vendored: [{ path: "vendor/<tarball>", package: "<npm name>", sha256: "<sha256sum>" }] }`.
  The `files` check verifies each one. Move one to a new release with
  `bun run --silent mshape dep bump <name> <tarball> --sha256 <digest>`.
- **Invariants of your own** become adopter rules: `docs/local-rules.md` shows how. List each
  rule module's directory in `sources.include`, for example `rules/**/*.ts`.

## 4. tsc and biome

Every TypeScript file must be in both tools' file lists, `shape.config.ts` included. Keep your
own configs and add what's missing. Without one, start from these:

```jsonc
// tsconfig.json
{ "extends": "monkeyshape/tsconfig.base.json", "include": ["src", "test", "shape.config.ts"] }
```

```jsonc
// biome.json
{
  "root": true,
  "extends": ["monkeyshape/biome"],
  "files": { "includes": ["src/**", "test/**", "shape.config.ts", "*.json"] }
}
```

Then run your formatter (`biome check --write .`) over the new files.

## 5. The gate

Make it one script, the same locally and in CI:
`tsc && biome ci --error-on-warnings && mshape check && bun test`.
`tsc` and `biome` are required. If either can't run, `mshape check` fails rather than skip
it.

## 6. The working loop

The repo's agent instructions belong in AGENTS.md, within its budget:

```md
<!-- AGENTS.md -->
# My project: commands, gotchas and decision authority for agents, in 150 lines or fewer.
```

`CLAUDE.md` holds only `@AGENTS.md`. If `bd setup` appended its beads block there, remove it:
`.beads/PRIME.md` replaces it at every session start. Don't run `bd setup claude` again.
Without beads yet, run `bd init --skip-agents`. In a clone that has `.beads/` but no
database, run `bd bootstrap`.

Then run `bun run --silent mshape sync`. It installs:

- the shared skills, in `.agents/skills`, linked from `.claude/skills`;
- `.beads/PRIME.md`;
- the PR template;
- monkeyshape's hooks in `.claude/settings.json`, beside any hooks you already have.

`sync` never overwrites a file you wrote:

- **A skill with a shipped name.** Rename yours to keep it: move the directory and change
  `name:` in its SKILL.md. To take the shared one instead, use
  `sync --replace .agents/skills/<name>`.
- **Your own PRIME.md or PR template.** Move what it says to AGENTS.md, then run
  `sync --replace <file>`.

Run `sync` again until it exits 0. After that it is automatic.

## 7. Grandfather the rest

After `sync`, never before, run `bun run --silent mshape baseline --init`. It records every
current violation per file in .shape/baseline.json. Review that diff like code. As you fix
things, `mshape baseline --tighten` lowers the counts, and a count is never raised. Then
commit, and the gate is green.

## Afterwards: your knowledge, in four kinds

An AGENTS.md over its budget is grandfathered, not cut. Sort it over time:

- **History.** Why something is the way it is: keep it, in `DECISIONS.md` or `docs/`, where
  it isn't loaded into every session.
- **Short instructions.** Commands, gotchas and who decides: AGENTS.md.
- **Obsolete.** Text that is no longer true: retire it once you have checked.
- **Invariants.** Anything that must always hold: a test or an adopter rule, which then
  enforces it instead of the text.

The skills and conventions (`docs/workflow.md` in the package) assume the layout `init`
creates: `docs/roadmap.md`, `plan/`, `notes/`, and a decision-authority section in AGENTS.md.
`/roadmap` writes the first of these. Add the rest as the loop needs them.
