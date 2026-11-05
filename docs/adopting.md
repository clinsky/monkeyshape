# Adding monkeyshape to an existing repo

A new repo should start with `mshape init` (see the README). This guide is for a repo that
already exists. Follow it in order: each step leaves the repo working.

Nothing here is deleted to fit a budget or silence a check. Whatever you don't fix today is
grandfathered by the baseline in step 7, and from then on its count can only go down. The
tests build a repo from exactly the file blocks below and run its gate.

## 1. Install, pinned

In a fresh clone, run `bun install` first. Then add only the packages you don't already
have, at exact versions:

```sh
bun add -d --exact monkeyshape effect @biomejs/biome typescript @types/bun
```

Leave out any you already depend on. Re-adding a package rewrites its pinned version as a
range. monkeyshape runs on Bun. It asks your `tsc` and `biome` which files they cover, and
`effect` is its peer dependency.

To install monkeyshape from a release tarball rather than npm, copy the tarball into
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
- **`entry`** lists, as globs, the files that run things, such as `entry: ["main.ts", "scripts/**/*.ts"]`.
  The clock, the environment and console output are allowed there.
- **Other languages are covered, never analyzed.**
  - Executable source that isn't TypeScript needs a command that checks it. That includes C,
    Python, shell, Java and Go, or any file with git's executable bit.
  - Declare it as `coverage: { commands: [{ files: ["native/**"], run: ["make", "-C", "native", "check"] }] }`.
    `files` says which files the command covers. Nothing is passed to it: `run` is argv, not a
    shell line, and names what it checks, like any command line.
  - Make it write nothing into the tree. For one Python script, use
    `["python3", "-c", "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]", "scripts/report.py"]`,
    not `py_compile`. For one shell script, use `["bash", "-n", "scripts/setup.sh"]`.
  - `optional: true` turns a missing program into a note. A program that runs and fails is red.
    So is exit 127, which is also how `bash` reports a file it can't find.
  - A file no command can check here, such as a test fixture or a plugin compiled by another
    tool, goes in `coverage.exemptFiles` as `{ path, reason }`.
  - The executable bit is only a heuristic. A script with an unusual extension and no bit
    still needs a command or an exemption.
- **Vendored tarballs.** Record every tarball under `vendor/`, including ones from before you
  adopted: `files: { vendored: [{ path: "vendor/<tarball>", package: "<npm name>", sha256: "<sha256sum>" }] }`.
  The digest is the one its publisher states, on the release page or in your own notes. For
  a tarball with no stated digest, one you built or were handed, use the `sha256sum` of the
  file once you trust where it came from. The `files` check verifies each one. Move one to a new release with
  `bun run --silent mshape dep bump <name> <tarball> --sha256 <digest>`.
- **Invariants of your own** become adopter rules: `docs/local-rules.md` shows how. List each
  rule module's directory in `sources.include`, for example `rules/**/*.ts`.

## 4. tsc and biome

Every TypeScript file must be in both tools' file lists, `shape.config.ts` included. Keep your
own configs and add what's missing. Extending monkeyshape's bases, as the blocks below do, is optional: they are its opinions on strictness and lint, which you can
take later. Without configs of your own, start from these:

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

Then format the files you added: `bunx biome check --write shape.config.ts tsconfig.json biome.json`.

A file you hold out of either list for a reason stays out. The baseline in step 7
grandfathers it as `coverage/typecheck` or `coverage/lint`. For example, keep out a script
that doesn't typecheck yet, or a directory biome has never linted. When you add a directory
to biome, biome itself may fail on code it hadn't seen. The baseline can't grandfather that.
See the cost first with `bunx biome check <dir>`. Then fix those files, or leave the directory
out. Commit the reformatting that comes with them on its own.

## 5. The gate

Make it one script, the same locally and in CI:
`tsc && biome ci --error-on-warnings && mshape check && bun test`. Keep the scripts you have
and chain them: `bun run typecheck && biome ci --error-on-warnings && mshape check && bun test`.
Use `biome ci`, not `biome check`, so the gate fails rather than writes.
`tsc` and `biome` are required. If either can't run, `mshape check` fails rather than skip
it.

## 6. The working loop

The repo's agent instructions belong in AGENTS.md, within its budget:

```md
<!-- AGENTS.md -->
# My project: commands, gotchas and decision authority for agents, in 150 lines or fewer.
```

`CLAUDE.md` holds only `@AGENTS.md`. If `bd setup` appended its beads block there, remove it:
`.beads/PRIME.md` replaces it at every session start. Don't run `bd setup claude` again. The files `bd setup` wrote for other agents (for Cursor or
Codex) can stay: monkeyshape doesn't read them.
Without beads yet, run `bd init --skip-agents`. In a clone that has `.beads/` but no
database, run `bd bootstrap`, which rebuilds it from what git tracks.

Then run `bun run --silent mshape sync`. It installs:

- the shared skills, in `.agents/skills`, linked from `.claude/skills`;
- `.beads/PRIME.md`;
- the PR template;
- monkeyshape's hooks in `.claude/settings.json`. A bare `bd prime --hook-json` hook is
  replaced by the same command with a fallback note. Your other hooks and settings are kept.

`sync` never overwrites a file you wrote:

- **A skill with a shipped name.** If yours is specific to the project, rename it to keep it:
  move the directory and change `name:` in its SKILL.md. Both then load, so say in its
  description when to use it rather than the shared one. If yours is an older copy of the
  shared one, use `sync --replace .agents/skills/<name>`.
- **Your own PRIME.md or PR template.** Move what it says to AGENTS.md, then run
  `sync --replace <file>`.

Run `sync` again until it exits 0. After that it is automatic.

## 7. Grandfather the rest

After `sync`, never before, run `bun run --silent mshape baseline --init`. It records every
current violation per file in .shape/baseline.json. Review it by rule, not line by line: a
large count of one rule is usually one habit of the codebase, and each rule's message says
what it costs. As you fix
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
