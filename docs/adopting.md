# Adding monkeyshape to an existing repo

A new repo should start with `mshape init` (see the README). This guide is for a repo that
already exists. Follow it in order: each step leaves the repo working.

Nothing here is deleted to fit a budget or silence a check. Whatever you don't fix today is
grandfathered by the baseline in step 7, and from then on its count can only go down. The
tests build a repo from exactly the file blocks below and run its gate.

## 1. Install, pinned

Install `mshape` once per machine. The hooks and skills run it from the PATH, and inside a
repo it runs the version the repo pins:

```sh
curl -fsSL https://github.com/clinsky/monkeyshape/releases/latest/download/install.sh | sh
```

In a fresh clone, run `bun install` first. Then add only the packages you don't already
have, at exact versions, with `monkeyshape` at the version `mshape --version` prints:

```sh
bun add -d --exact monkeyshape@<version> effect @biomejs/biome typescript @types/bun
```

Leave out any you already depend on. Re-adding a package rewrites its pinned version as a
range. The package carries the configs step 4 extends, `mshape` asks your `tsc` and `biome`
which files they cover, and `effect` is its peer dependency.

To install monkeyshape from a release tarball rather than npm, copy the tarball into
`vendor/` and run `bun add -d --exact ./vendor/<tarball>`. Then record it as step 3 shows.

## 2. Try it first

Before changing the repo, write a config somewhere else and point at it:

```sh
mshape check --config ../trial/shape.toml
```

Start from `packs = ["typescript"]`. The report names each check, says what it examined, and
explains every finding.

In a clone with `.beads/` but no beads database, the trial skips the rules that need beads,
and a `note:` names them. One of them, `refs/bead-in-code`, can be the largest count of all.
For the full picture, run `bd bootstrap` first, as step 6 describes.

## 3. shape.toml

For a repo whose code is under `src/`:

```toml
# shape.toml
packs = ["typescript"]

[arch.modules.core]
description = "Deterministic logic. No host I/O."

# optional: no adapter code yet. A module that matches no file fails unless optional.
[arch.modules.adapters]
description = "Host I/O behind services."
may-import = ["core"]
host-access = true
optional = true
```

Then pin the `mshape` the repo runs, so every machine and CI run the same one: an `[mshape]`
table with `version`, as `mshape --version` prints it, and `sums`, the sha256 of that
release's `SHA256SUMS` (`curl -fsSL https://github.com/clinsky/monkeyshape/releases/download/v<version>/SHA256SUMS | sha256sum`).
`mshape config schema` prints the JSON Schema an editor can check the file against.

Each check reads its own part of the config. Top-level keys such as `entry` go before the
first table.

- **`sources`** lists the TypeScript the rules analyze. The default is `src/**` and `tools/**`.
  Every other TypeScript file must be a test, a `.d.ts`, or under `sources.exempt` with a
  reason, or the `sources` check fails. Code spread over top-level directories is listed in
  `include = ["*.ts", "lib/**/*.ts", "scripts/**/*.ts"]` under `[sources]`. That list replaces
  the default, so list `src/**/*.ts` too if you have code there.
- **`arch`** is the module map. Every file in `sources` must belong to a module. With code
  outside `src/`, set `root = "."` under `[arch]`. A module's key is then its directory (`lib`)
  or a single file (`main.ts`, quoted: `[arch.modules."main.ts"]`). A directory such as `tools/`
  that matches no module fails as `arch/unknown-module`: give it a module, or narrow `sources`.
- **Packages.** A module may import `effect` and the packages in `arch.allowed-packages`. One
  module's own extra packages go in its `packages`. `host-access = true` lets a module use
  `node:*`, `Bun` and the like.
- **`entry`** lists, as globs, the files that run things, such as
  `entry = ["main.ts", "scripts/**/*.ts"]`. The clock, the environment and console output are
  allowed there.
- **Other languages are covered, never analyzed.**
  - Executable source that isn't TypeScript needs a command that checks it. That includes C,
    Python, shell, Java and Go, or any file with git's executable bit.
  - Declare it under `[coverage]` as
    `commands = [{ files = ["native/**"], run = ["make", "-C", "native", "check"] }]`.
    `files` says which files the command covers. `run` is argv, not a shell line. An argument
    `"{files}"` becomes exactly the files `files` matched, so the glob can't claim more than
    the command checks; without it, nothing is passed, and `run` names what it checks.
  - Make it write nothing into the tree. For Python scripts, use
    `["python3", "-c", "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]", "{files}"]`,
    not `py_compile`. For shell scripts, loop, since `bash -n` reads only its first file:
    `["sh", "-c", 'for f; do bash -n "$f" || exit; done', "sh", "{files}"]`.
  - `optional = true` turns a missing program into a note. A program that runs and fails is
    red. So is exit 127, which is also how `bash` reports a file it can't find.
  - A file no command can check here, such as a test fixture or a plugin compiled by another
    tool, goes in `coverage.exempt-files` as `{ path = "…", reason = "…" }`.
  - The executable bit is only a heuristic. A script with an unusual extension and no bit
    still needs a command or an exemption.
- **Vendored tarballs.** Record every tarball under `vendor/`, including ones from before you
  adopted, under `[files]`:
  `vendored = [{ path = "vendor/<tarball>", package = "<npm name>", sha256 = "<sha256sum>" }]`.
  The digest is the one its publisher states, on the release page or in your own notes. For
  a tarball with no stated digest, one you built or were handed, use the `sha256sum` of the
  file once you trust where it came from. The `files` check verifies each one. Move one to a new release with
  `mshape dep bump <name> <tarball> --sha256 <digest>`.
- **Invariants of your own** become adopter rules, `shape-rules/<id>.yml`:
  `docs/local-rules.md` shows how.
- **A rule that misfits some files** takes `allow = [{ path = "…", reason = "…" }]`, or
  `off = "<reason>"` to stop it everywhere: under `[rules.no-throw]` for a rule, and under
  `[refs.rules.section-citation]` for a `refs/` kind. An allowance that silences nothing
  fails, so delete it once its files are fixed.
- **A repo with a shape.config.ts**, from before 0.6.0, follows Upgrading's 0.6.0 entry
  instead: `mshape config migrate` writes `shape.toml` with the same values.

## 4. tsc and biome

Every TypeScript file must be in both tools' file lists. A file typechecked by another
tsconfig, such as a sub-app's, counts once you list that tsconfig too:
`tsconfigs = ["tsconfig.json", "app/tsconfig.json"]` under `[coverage]`. Keep your
own configs and add what's missing. Extending monkeyshape's bases, as the blocks below do, is optional: they are its opinions on strictness and lint, which you can
take later. Without configs of your own, start from these:

```jsonc
// tsconfig.json
{ "extends": "monkeyshape/tsconfig.base.json", "include": ["src", "test"] }
```

```jsonc
// biome.json
{
  "root": true,
  "extends": ["monkeyshape/biome"],
  "files": { "includes": ["src/**", "test/**", "*.json"] }
}
```

Then format the files you added: `bunx biome check --write tsconfig.json biome.json`.

A file you hold out of either list for a reason stays out. The baseline in step 7
grandfathers it as `coverage/typecheck` or `coverage/lint`. For example, keep out a script
that doesn't typecheck yet, or a directory biome has never linted. When you add a directory
to biome, biome itself may fail on code it hadn't seen. The baseline can't grandfather that.
To see the cost, add the directory to biome's `includes`, then run
`bunx biome ci --error-on-warnings <dir>`, which counts warnings as the gate does. Biome
ignores a directory outside its `includes`, so a check run before that shows nothing. Then
either fix the files or take the directory back out:

- `bunx biome check --write <dir>` applies the formatting and the safe fixes;
- what's left is fixed by hand, or by `--write --unsafe` on one file after reading the fix.

Commit the reformatting on its own.

## 5. The gate

`mshape gate` is the gate, the same locally and in CI. The TypeScript pack's stages run
`tsc -p .` and `biome ci --error-on-warnings .`, then `mshape check`, then `bun test`. A
stage of your own in shape.toml runs after them, and one with a pack stage's name replaces it:

```toml
[[gate.stages]]
name = "tsc"
run = ["bun", "run", "typecheck"]
fast = true
```

- **Fix biome's warnings first.** `biome ci --error-on-warnings` fails on warnings that your
  old `biome check` let pass, and the baseline can't grandfather them. Before you switch, run
  `bunx biome ci --error-on-warnings` and fix what it reports, as for a new directory in
  step 4.
- **Your old `lint` and `check` scripts.** Point them at `mshape gate`, or delete them, so
  they agree with the gate.
- **Your own architecture checks.** A script that checks imports between directories can
  stay, as a stage of its own. Drop it once the module map says the same.
- **CI** installs `mshape` at the pin with `install.sh` (`MSHAPE_VERSION=<version>`), runs
  `bun install --frozen-lockfile`, then `mshape gate`.

`tsc` and `biome` are required. If either can't run, `mshape check` fails rather than skip
it.

## 6. The working loop

The repo's agent instructions belong in AGENTS.md, within its budget:

```md
<!-- AGENTS.md -->
# My project: commands, gotchas and decision authority for agents, in 150 lines or fewer.
```

`CLAUDE.md` holds only `@AGENTS.md`. `bd setup` appends blocks between `BEGIN BEADS …` and
`END BEADS …` markers to CLAUDE.md, AGENTS.md or both. One is `INTEGRATION`, and
`bd setup codex` adds `CODEX SETUP`. Remove every such block: `.beads/PRIME.md` replaces them at every
session start. Don't run `bd setup claude` again. The files `bd setup` wrote for other agents (for Cursor or
Codex) can stay: monkeyshape doesn't read them.
Without beads yet, run `bd init --skip-agents`. In a clone that has `.beads/` but no
database, run `bd bootstrap`. If the `sync.remote` in `.beads/config.yaml` already holds
beads, it clones them from there, so run it only where that remote is the one you mean.
Otherwise it rebuilds them from the issues file git tracks under `.beads/`. Either way it
records that remote for `bd dolt push`, which you run only when you mean to share.
Where bd can't run, as in CI, `mshape check` reads the beads from bd's export, if you commit
one as `issues.jsonl` in `.beads/` (`bd export -o <file>`), and its `beads` line says so.

Then run `mshape sync`. It installs:

- the shared skills, in `.agents/skills`, linked from `.claude/skills`;
- `.beads/PRIME.md`;
- the PR template;
- monkeyshape's hooks in `.claude/settings.json`: `mshape prime` at session start (PRIME.md,
  the session's registration and its unread mail) and the unread mail at each prompt. A bare
  `bd prime --hook-json` hook is replaced by it. Your other hooks and settings are kept.

`sync` never overwrites a file you wrote:

- **A skill with a shipped name.** If yours is specific to the project, rename it to keep it:
  move the directory and change `name:` in its SKILL.md. Both then load, so say in its
  description when to use it rather than the shared one. If yours should always win in this
  repo, start its description with that, for example "Use instead of the shared review-pr". If yours is an older copy of the
  shared one, use `sync --replace .agents/skills/<name>`.
- **Your own PRIME.md or PR template.** Move what it says to AGENTS.md, then run
  `sync --replace <file>`.

Run `sync` again until it exits 0. After a bump of monkeyshape, `mshape check` fails until
you run `sync` again.

## 7. Grandfather the rest

After `sync`, never before, run `mshape baseline --init`. It records every
current violation per file in .shape/baseline.json, and prints the counts by rule. Review it
by rule, not line by line: a large count of one rule is usually one habit of the codebase, and
each rule's message says what it costs. As you fix
things, `mshape baseline --tighten` lowers the counts, and a count is never raised. Then
commit, and the gate is green. A file over its count later reports the occurrences on lines
your branch changed since `main`, or every one when none is, as after moving code.

## Upgrading

Take a new release by moving the pin: shape.toml's `[mshape]` `version` and `sums` (the sha256
of that release's `SHA256SUMS`), and `bun add -d --exact monkeyshape@<version>` to match. Then
`mshape sync`, then the gate. What a release asks of a repo that already
adopted:

- **0.6.0.** The config is `shape.toml`, data rather than code, and `mshape` is one binary per
  machine that runs the version the repo pins. From 0.5.0, in order:
  1. Install `mshape` as step 1 shows, and take the package:
     `bun add -d --exact monkeyshape@0.6.0`.
  2. Write each rule in `localRules` as `shape-rules/<id>.yml`, with its cases
     ([docs/local-rules.md](local-rules.md) says how). Until each has its file, migrate
     refuses, naming the rules left.
  3. Run `bun run --silent mshape config migrate`. It runs under the package, since it imports
     the old config, which the installed binary can't. It writes `shape.toml` with the same
     values, `packs = ["typescript"]` and `[mshape]` pinning 0.6.0, then deletes
     shape.config.ts, and notes each doc that still names it. Add `sums` to the pin as step 3
     shows.
  4. Delete the old rule modules and every place that listed them or shape.config.ts:
     `sources`, `tsconfig.json`'s `include`, biome's `includes`, and those docs.
  5. Run `mshape sync`, then `mshape gate`. Point your `check` script and CI at `mshape gate`,
     as step 5 shows. The `"mshape"` package script is no longer needed: hooks and skills run
     the installed `mshape`.
- **0.5.0.** The `budgets` check gains `decision-unlinked`: each file a decision's
  `Enforced by` names must cite the decision's slug (`D-<slug>`) in a comment, so whoever edits
  it is told why it must stay. Add the citations (each message names the slug and the file), or
  grandfather them with `mshape baseline --init` and burn them down. `--init` recounts every
  rule from what it finds now, so run it when these are the only failures; it keeps, unchanged,
  the entries of any rule this checkout can't evaluate (the bead rules, without `bd`). `track pr` now runs the
  gate's fast stages and leaves the tests to CI when the repo's CI runs the gate on every PR;
  otherwise it runs the whole gate locally, as before. A reviewer's address is
  `review-<track>`.

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
