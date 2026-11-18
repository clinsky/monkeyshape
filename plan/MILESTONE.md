# Milestone 5: a language-neutral core, and Rust and Python packs

**2026-11-18.** Once tracks start, this plan is frozen, except that an approved divergence is
appended under "Amendments" with its date, what changed, why, and who approved it.

## Why this milestone

monkeyshape is a TypeScript-and-Bun tool with a language-neutral loop trapped inside it. The
maintainer's next two repos are a Rust project and a Python project, two separate repos,
and neither starts until it can be born on monkeyshape with no workaround. Today it can't:

- **The config is code.** `shape.config.ts` is a TypeScript module that `mshape` imports, so a
  repo needs Bun and the npm package just to say what its modules are. Three of its values
  are functions (the `localRules` of two adopters), which no data format can hold.
- **The gate is hard-coded.** PRIME.md, the skills, the PR template, `track pr` and CI all
  say `bun run check`; `track pr`'s fast stages are tsc, biome and `mshape check`.
- **`mshape` runs only through Bun and `node_modules`.** `D-run-mshape` makes every hook and
  skill call `bun run --silent mshape`; the loop's text names `bun` 16 times across PRIME.md,
  the skills and the template's AGENTS.md. Milestone 4 spent three sessions on hooks that
  couldn't find `bun` after a restart.
- **The checks that look at code are TypeScript's.** `arch`, `sources`, `rules` and
  `coverage` read TypeScript through oxc, tsc and biome; `refs` reads comments only in
  TypeScript (`sgy`). The rest (budgets, files, skills, sync, beads, decisions, refs over
  docs) are pure functions over a `Snapshot` (`D-pure-checks`) and are neutral once their
  inputs are.

It comes now, ahead of the harness adapters, because two real repos wait on it and no Codex
or pi user does yet (`docs/roadmap.md`'s order, confirmed by the maintainer on 2026-11-18).
The core and the packs are one milestone so the interface is shaped by TypeScript and Rust
rather than guessed, and tested by Python, which must fit it unchanged.

Milestone 4 closed with 0.5.0 (#90); its plan is `notes/2026-11-18-milestone-4.md`.

## Goal, and how we'll know

1. **Config is data.** `shape.toml`, validated by a schema monkeyshape ships, replaces
   `shape.config.ts`. `mshape config migrate` converts a repo once; no second format is kept.
2. **The gate is configured.** `mshape gate` runs the repo's gate: each pack's default
   stages, then the repo's own, read from `shape.toml`; `--fast` runs the stages marked fast.
   PRIME.md, the skills, the PR template, `track pr` and CI name `mshape gate`, never a
   language's tool.
3. **`mshape` is a pinned binary.** Bun compiles it into GitHub release assets for Linux x64
   and arm64 and macOS arm64, listed with their hashes in a `SHA256SUMS` asset. `shape.toml`
   pins the version and the hash of that list. A machine installs `mshape` once with
   `curl -fsSL <release>/install.sh | sh`; inside a repo it runs the pinned version, fetched
   and verified. Every hook, skill and doc calls `mshape`. A non-TypeScript repo has
   no `package.json` and no `node_modules`. `mshape sync` replaces hooks monkeyshape changed
   (`iwf`). npm keeps shipping what TypeScript code imports or extends.
4. **A language-pack interface, with TypeScript refactored into the first pack.** A pack
   claims its files and tests, loads its toolchain's view of them, builds the import graph
   the now-neutral `arch` check runs over, carries its `core`-layer rules, delivers its base
   configs, and contributes an init template and default gate stages. A repo lists its packs;
   the core runs each.
5. **Adopter rules through ast-grep, in every language.** A repo's own rules are ast-grep
   rule files with their must-fail and must-pass cases; the engine keeps owning scope,
   allowances, `shape-ignore` and ratchets. `localRules` is removed after the adopters' three
   rules are ported. `refs` reads comments in every pack's languages (`sgy`).
6. **A Rust pack and a Python pack.** Rust: cargo metadata, the crate graph as modules,
   clippy, rustfmt, curated workspace lints. Python: uv, ruff, ty, pytest, the import graph
   as modules, curated ruff and ty rules. Python is built on the frozen interface and doesn't
   change it.

**Acceptance on real data:**

- **The Rust repo** (a Cargo workspace of several crates) and **the Python repo** (a uv
  project), both private, are born with `mshape init` from the release that ships this
  milestone: green on their first `mshape gate`, with no `package.json`, `node_modules` or
  Bun anywhere in them or needed on the machine. Each runs its first track through the loop
  to a merged PR: session start loads the loop, mail arrives, `track pr` pushes, CI runs
  `mshape gate`. Recorded as counts and outcomes in the closing PR, never their content.
- **The three adopters** (two existing applications and the repo born on 0.4.0) are
  migrated by `mshape config migrate` and stay green on that release: the same check outcomes
  as on 0.5.0 except what this milestone changes, each line of difference explained; their
  ported ast-grep rules report what their `localRules` reported on the same commit.
- **ty's coverage:** a corpus of real agent-written Python (from this milestone's tracks and
  the Python repo's first track), each defect labelled, is run through the Python pack's gate;
  the closing PR lists what ruff and ty catch, what they miss, and which miss became a rule.
- **The interface held:** the Python pack's PRs change nothing in `src/packs/pack.ts`, or each
  change is an amendment recorded below with the reason TypeScript and Rust missed it.
- **This repo** runs `mshape gate` in CI and through `track pr`, from source.

**Release:** 0.6.0 at the end: the npm package and the binaries, published by the maintainer.
The two new repos are born from it, so it ships before the acceptance runs; a P1 defect the
acceptance finds is fixed in 0.6.x before the milestone closes, and a P2 limitation is
deferred with a reason and the maintainer's yes.

## Non-goals

- **Init for a repo of several languages, and dependencies between packs** (a Python
  extension built from a crate): no consumer; no adopter has a second language beyond a few
  files its declared commands already cover. The interface takes a list of packs and a test
  composes two (goal 4), so the later work adds no new concept.
- **Porting monkeyshape's own TypeScript rules to ast-grep:** they stay on oxc inside the
  TypeScript pack (`D-own-rule-engine`); only adopter rules move.
- **Harness adapters (`dlz`):** milestone 6. The hooks stay Claude Code's; only their command
  changes. Nothing here may add a Claude Code-specific mechanism.
- **Windows, and languages other than TypeScript, Rust and Python.**
- **Keeping `shape.config.ts` working beside `shape.toml`:** one format; the migration is
  a command and every known repo runs it this milestone.
- **A package manager for the binary** (Homebrew, cargo install, pip): the install script is
  the one way; others wait for a consumer outside the maintainer.
- **CI under a minute (`3q2`):** deferred by the maintainer.
- **`validate` (`97o`), the agentic layer (`v56`), Effect (`rrn`), starter rules (`hh2`):**
  later goals, each now cheaper on the neutral core; no consumer this milestone.

## Where we are

| Area | Today | After |
|---|---|---|
| Config | `shape.config.ts`, a TS module; 3 adopters + this repo | `shape.toml` + shipped schema |
| Adopter rules | 3 `localRules` functions in 2 adopters | ast-grep rule files |
| The gate | `bun run check` in 8 loop files and CIs | `mshape gate` from config |
| Running `mshape` | `bun run --silent mshape` (`D-run-mshape`), `bun` in 16 lines of loop text | `mshape`, installed once, running each repo's pinned and verified version |
| Checks that read code | 4 of 10 TypeScript-only, `refs` comments TS-only | each through the repo's packs |
| Packs | none; TypeScript fused into the core | typescript, rust, python |
| Release | npm tarball | npm + 3 binaries + `SHA256SUMS` |

## What changed since milestone 4, and why

- Milestone 4 shipped as 0.5.0 (#90); its retrospective was held with the maintainer. Its
  adopter acceptance (`4sa.21`) is closed as it stands, by the maintainer's call, and `3q2`
  (CI time) is deferred.
- The maintainer decided, 2026-11-18: the core and both packs are one milestone; the Rust and
  Python repos are two separate projects, a Cargo workspace and a uv project; Python's type
  checker is **ty**, over basedpyright and mypy: native, fast, and with no Node in the
  toolchain, standardising on uv, ruff and ty; pinned, with its coverage measured against
  real agent-written code (acceptance), because it is young. A repo of several languages
  will be needed eventually: designed for here, built when a consumer comes.
- `mshape` installs the way uv, rustup and bun do, `curl -fsSL <release>/install.sh | sh`,
  the maintainer's call, 2026-11-18: one install per machine, then plain `mshape` everywhere,
  still running each repo's pinned and verified version. It replaces a script committed to
  every repo.
- ast-grep, a new runtime dependency approved in principle in milestone 4's roadmap, is
  delivered by `mshape` itself (goal 3's interfaces).

## Interfaces the tracks share

### Ownership of files

Ownership says who to tell, not who may edit (milestone 4's ruling, `jbq`): a track whose
change needs another's file edits it, says so in its PR body and sends the owner one line.

- **`config`:** `src/schemas/config.ts`, `src/adapters/config.ts`, the shipped schema
  `schema/shape.schema.json`, `mshape config migrate`, `mshape gate`, `src/core/conventions.ts`,
  `src/{core,adapters}/trackPr.ts`, `.github/workflows/` and the template's CI, and this
  repo's `shape.toml`.
- **`binary`:** `src/{core,adapters,cli}/release.ts`, `install.sh` and the launcher (a new
  `src/{core,adapters}/launch.ts`), `src/core/hooks.ts`, `src/{core,adapters}/sync.ts`, a new
  `src/adapters/tools.ts` (fetching ast-grep), `test/integration/invoke.test.ts`,
  `D-run-mshape`; and the loop's text: `template/.beads/PRIME.md` and this repo's copy,
  `skills/`, `template/AGENTS.md`, AGENTS.md, README, `docs/adopting.md`.
- **`packs`:** `src/packs/pack.ts` (the interface), `src/packs/typescript/`,
  `src/core/{check,arch,sources,coverage,refs,parse,scope}.ts`, `src/core/rules/`,
  `src/adapters/workspace.ts`, `src/{core,adapters}/init.ts` and `src/core/scaffold.ts`,
  `template/` outside `template/packs/{rust,python}`, `docs/local-rules.md`, and any file not
  listed here.
- **`rust`:** `src/packs/rust/`, `template/packs/rust/`, `config/rust/`, `test/packs/rust/`.
- **`python`:** `src/packs/python/`, `template/packs/python/`, `config/python/`,
  `test/packs/python/` with the ty corpus.
- **Shared tables, additions only:** `KINDS` in `src/core/check.ts`, the command table in
  `src/cli/main.ts`, `test/core/ruleCases.test.ts`, the pack registry `src/packs/index.ts`.

### `shape.toml` (owner `config`; every track consumes it)

One file at the repo root. Keys mirror today's `ShapeConfig` (`sources`, `arch`, `rules`,
`refs`, `budgets`, `files`, `coverage`, `tracks`, `beads`, `checks`, `layers`), plus:

```toml
packs = ["rust"]                       # one or more, in the order their stages run

[mshape]
version = "0.6.0"
sums = "<sha256 of the release's SHA256SUMS>"
# dev = ["bun", "src/cli/main.ts"]     # this repo only: run from source

[gate]                                 # the repo's stages, after its packs' defaults
stages = [{ name = "native", run = ["make", "-C", "native", "check"], fast = false }]

[arch.modules.core]                    # each module belongs to exactly one pack
pack = "rust"                          # optional when the repo has one pack
paths = ["crates/core"]
may-import = ["schemas"]
```

`localRules` is gone; adopter rules are files (below). Each pack owns one table,
`[typescript]`, `[rust]` or `[python]`, for what only it reads; the schema says which. Keys
are kebab-case; `config` publishes the schema with the release so editors validate it.
`config` lands the loader and the schema first; other tracks add their keys to it.

| Case | Result |
|---|---|
| `shape.toml` only | read; a value the schema rejects fails with its key path and the schema's reason |
| `shape.config.ts` only | fails: "run `mshape config migrate`" (0.6.0 reads no TS config) |
| both | fails, naming both: one config |
| neither | as today's missing config: `init` makes one |
| an unknown key | fails, naming it (a typo must not pass silently) |
| `packs` missing | fails, listing the packs whose files the repo has |
| a pack listed with no file of its own | passes; its checks report not-applicable |
| a module with no `pack` in a two-pack repo | fails, naming the module |

### `mshape config migrate` (owner `config`; consumers every adopter and this repo)

Runs under 0.6.0's npm package in a TypeScript repo (it must import the old config) and
writes `shape.toml` beside it, with `packs = ["typescript"]` and the current pin, then
deletes `shape.config.ts`. It changes nothing else.

| Case | Result |
|---|---|
| a config of plain values | `shape.toml` written; `mshape check` gives the same outcomes |
| `localRules` set, rules not yet ported | refuses, naming each rule and `docs/local-rules.md` |
| `localRules` set, each id present under `shape-rules/` | writes the config without them |
| values computed in code (a spread, an imported constant) | written as their resolved values, with a note per key |
| an allowance's reason | kept verbatim |
| `shape.toml` already present | refuses: already migrated |
| run twice after success | refuses, as above |

### `mshape gate` (owner `config`; consumers `binary`'s text, `track pr`, CI, every pack)

A stage is `{ name, run: argv, fast, ok-exit }` (`ok-exit` defaults to `[0]`). The gate runs
in two phases, so `--fast` has one cut point:

1. **fast:** every pack's fast stages, in `packs` order; then `mshape check`; then the repo's
   `[gate].stages` marked fast;
2. **full:** every pack's full stages, in `packs` order; then the repo's other stages.

`--fast` runs phase 1; `track pr` runs `--fast`, CI runs both. Each stage's outcome is one
line, as `mshape check`'s are; a failure doesn't stop the stages after it.

A pack's defaults are what a born repo's gate runs today, so migrating changes no outcome:

| Pack | Fast | Full |
|---|---|---|
| typescript | `tsc -p .`, `biome ci --error-on-warnings .` | `bun test --pass-with-no-tests` |
| rust | `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings` | `cargo test --workspace` (passes with no tests) |
| python | `uv run ruff format --check`, `uv run ruff check`, `uv run ty check` | `uv run pytest`, `ok-exit = [0, 5]` (5: no tests collected) |

A repo changes a pack stage by naming it in `[gate].stages`: that stage replaces the pack's,
in the pack's place and phase unless it says `fast`. This repo replaces `typescript`'s test
stage with `bun test --parallel --timeout=30000` (#93).

| Case | Result |
|---|---|
| every stage passes | exit 0 |
| a fast stage fails | the rest still run; exit 1; the failing stage's output kept in full in a log |
| `--fast` | phase 2's stages are listed as skipped, not run |
| a pack stage's program missing | fails if it is a required prerequisite of its pack; a `note:` if optional (the outcome contract) |
| a repo stage's program missing | fails, naming it: a repo stage is always required |
| a repo stage with a pack stage's name | replaces it, in the pack stage's place and phase unless it sets `fast` |
| two repo stages with one name | fails at config load, naming it |
| a stage exits with a code in its `ok-exit` | passes |
| a fresh born repo with no tests yet | green in every pack (`--pass-with-no-tests`; cargo passes; pytest's 5 is ok) |
| `packs = ["typescript", "python"]` | `tsc`, `biome`, `ruff format`, `ruff check`, `ty`, `mshape check`, repo fast stages, then `bun test`, `pytest`, repo full stages |
| a repo whose CI doesn't run the gate | `track pr` runs both phases, as today |

### Installing and running `mshape` (owner `binary`; consumers every track, every repo)

One install per machine, as uv, rustup and bun do:

```sh
curl -fsSL https://github.com/clinsky/monkeyshape/releases/latest/download/install.sh | sh
```

`install.sh`, a POSIX sh release asset, downloads the binary for the machine and the release's
`SHA256SUMS`, verifies one against the other (curl or wget; sha256sum or shasum), and puts
`mshape` in `${MSHAPE_INSTALL_DIR:-$HOME/.local/bin}`, saying how to add that to the PATH when
it isn't there. `MSHAPE_VERSION` installs a given version (CI uses it). Then `mshape` is just
`mshape`, in every repo, hook, skill and doc.

The installed `mshape` honours the repo's pin, as rustup honours `rust-toolchain.toml`: inside
a repo whose `shape.toml` pins another version, it finds or fetches
`${XDG_CACHE_HOME:-$HOME/.cache}/monkeyshape/<version>/mshape`, verifies `SHA256SUMS` against
the pin's `sums` and the binary against `SHA256SUMS`, and execs it with its arguments. A repo
is held to its pin; the installed copy is only the launcher. ast-grep is pinned inside
`mshape` (version and per-platform hashes compiled in) and fetched into the same cache on
first use, verified; `shape.toml` pins only `mshape`. Cases, `binary`'s test:

| Case | Result |
|---|---|
| `curl ... \| sh` on a supported machine | installs, verified; prints the version and the PATH line if needed |
| the installer's download doesn't match `SHA256SUMS` | refuses, deletes it, installs nothing |
| the pin equals the installed version | runs itself, no network, once the pin's `sums` equals the hash of the `SHA256SUMS` `install.sh` verified (recorded beside the binary); a different `sums` refuses, naming both |
| another pinned version, cached and verified | execs it, no network |
| another pinned version, not cached, online | fetches, verifies, caches, execs |
| not cached, offline | exit 1 with a note naming the URL; a hook prints it and exits 0 |
| a hash mismatch against the pin | refuses, deletes the download, names the file and both hashes; never runs it |
| `dev` set (this repo) | runs `dev`'s argv, no fetch |
| outside any repo (`mshape init`) | runs itself; `init` pins the running version |
| an unsupported platform | the installer and the launcher refuse, naming it and the three supported |
| neither curl nor wget, or no sha tool | refuses, naming what's missing |
| `mshape` not on a hook's PATH | the hook tries `$HOME/.local/bin/mshape`, then prints a note with the install line and exits 0 |
| a track worktree | the same installed `mshape`; the cache is per machine |
| a TS repo whose npm `monkeyshape` differs from the pin | the `sync` check fails, naming both versions |
| ast-grep not cached, offline | rules that need it are `unavailable`, required (they are adopter rules) |
| `mshape` spawns Bun (tsc, biome, `bun install`, a declared `bun` command, `bun pm pack`) | through one helper in `src/adapters/process.ts`: `process.execPath` only when `mshape` itself runs under Bun (`dev`, npm); under the compiled binary, `bun` from the PATH, then `~/.bun/bin/bun` |
| the compiled binary, no `bun` found, in a TypeScript repo | the TypeScript pack's required prerequisite: its stages and checks fail, naming both places looked |
| the compiled binary in a Rust or Python repo | never looks for Bun |
| a bare `process.execPath` spawn anywhere else in `src/adapters/` | this repo's own adopter rule (`shape-rules/`) fails it, so the binary never forks itself |

A compiled `mshape` is its own `process.execPath`: spawning it to mean Bun (11 call sites
today, in `workspace`, `commands`, `init`, `dep`, `release` and `trackPr`) runs `mshape`
again. `binary` owns the helper and moves every call site to it, editing `packs`' files as
ownership allows; the AGENTS.md gotcha about `[process.execPath, bin]` and
`test/integration/consumer.test.ts` are rewritten with it. `D-run-mshape` is rewritten by
the PR that switches the hooks, not before.

### The pack interface (owner `packs`; consumers `rust`, `python`)

`src/packs/pack.ts`, drafted by `packs` from the TypeScript refactor and reviewed by `rust`
before either pack builds on it. A pack is a value with a pure part (core) and a loader
(adapters, `D-pure-checks`):

- `id`, and what it **claims**: its source globs, how it tells a test, its comment syntax
  (for `refs` and `shape-ignore`).
- **load**: runs its toolchain and returns its part of the `Snapshot`: which files its tools
  cover (as tsc's and biome's lists do today), and an **import graph** over its files, mapped
  to the module map's modules. `arch` runs over the graph, whatever the language.
- **rules**: its `core`-layer rules (oxc for TypeScript; ast-grep rules or tool lints for
  the others), reported through the one engine.
- **base configs**: each with its delivery, `extends` (TypeScript's tsconfig and biome) or
  `copy` (synced in, the `sync` check keeping it equal).
- **template**: `template/packs/<id>/`, laid over `template/common/` by `init --pack <id>`.
- **gate**: its stages (above), and its **prerequisites**, required or optional.

| Case | Result |
|---|---|
| a file one listed pack claims | that pack's checks see it |
| a file two listed packs claim | config fails, naming the file and both packs |
| a file no listed pack claims | checked only by the neutral checks (budgets, files, refs over docs) |
| a claimed language file of a pack not listed | `sources` reports it, naming the pack to list |
| an import between modules of different packs | not an edge: graphs are per pack |
| a required prerequisite missing | as today's tsc and biome: the check fails |
| two packs listed (the core test's TypeScript + Python fixture) | both run; findings merge; nothing assumes one |

**Freeze.** When the TypeScript refactor has merged and the Rust pack's first PR builds on
the interface, `packs` sends `main` the frozen `pack.ts`; `main` records it here as an
amendment, and `python` starts. After that, a change is a divergence, recorded with why.

### Adopter rules through ast-grep (owner `packs`; consumers every pack and adopter)

A repo's own rules are files `shape-rules/<id>.yml`: an ast-grep rule (`id`, `language`,
`rule`, `message`) plus monkeyshape's `metadata.bugClass`, and its cases in
`shape-rules/<id>.test.yml` (ast-grep's `valid`/`invalid`, at least one each). `mshape`
runs `ast-grep scan --json` and turns each match into an offset; the engine applies scope,
allowances, `shape-ignore` (in the file's comment syntax) and baselines as for every rule.
Rules report as `local/<id>`, as today.

| Case | Result |
|---|---|
| a match outside an allowance | `local/<id>` at its line, with the rule's message |
| a match under `shape-ignore local/<id>: reason` | suppressed; an unused one is reported, as today |
| a rule with no cases, or no `invalid` case | `local-rule` fails, naming the file |
| a case that doesn't behave as labelled | `local-rule` fails, naming the case |
| a rule YAML ast-grep rejects | `local-rule` fails with ast-grep's message |
| an id that collides with a core rule | fails, naming both |
| no `shape-rules/` | nothing to run; ast-grep isn't fetched |

### Copied base configs (owner `packs` for the mechanism, `rust` and `python` for content)

A `copy` base config lives at `.mshape/<file>` (for example `.mshape/ruff.toml`), written by
`mshape sync` and held equal by the `sync` check; the repo's own config points at it
(`extend = ".mshape/ruff.toml"`). Where a tool can't point at another file (Cargo's
`[workspace.lints]`), the pack says what it does and its case joins this table.

| Case | Result |
|---|---|
| the copy equals what the release ships | passes |
| edited by hand | `sync` fails, naming the file; the repo overrides in its own config instead |
| missing | `sync` fails: run `mshape sync` |
| the repo's config doesn't point at it | the pack's check fails, naming the key to add |

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `config` | goals 1, 2 | The `shape.toml` loader and shipped schema (first: others build on it); `config migrate` and its table; `mshape gate` and its table; `track pr` and CI on `--fast` and the full gate; the PR template's Gate wording; this repo migrated | The three adopters migrated by the command with the same outcomes; this repo's CI on `mshape gate` |
| `binary` | goal 3 | The compiled binaries and `SHA256SUMS` in `bun run release`; `install.sh`, the launcher and their table; ast-grep pinned and fetched; Bun spawned through one helper, never the binary itself; hooks and every loop text on `mshape` (`D-run-mshape` rewritten); `sync` replacing changed hooks (`iwf`) | A machine with no Bun installs by `curl \| sh` and runs a born repo's hooks and gate; a tampered download is refused |
| `packs` | goals 4, 5 | The interface, drafted with `rust` and frozen; TypeScript refactored into the first pack with no change in outcomes on this repo and the adopters; `arch` over a neutral graph; `refs` over every pack's comments (`sgy`); the ast-grep adopter rules and the three adopters' ports; `init --pack`; the two-pack test | This repo and the adopters: same outcomes as 0.5.0; each ported rule reports what its function did |
| `rust` | goal 6 | The Rust pack: cargo metadata for sources and the crate graph, clippy and rustfmt, curated workspace lints and their delivery, the template (a Cargo workspace), its gate stages. Starts at once on a draft interface, and reviews it | The Rust repo born green and through its first track |
| `python` | goal 6 | The Python pack: uv, ruff, ty (pinned), pytest, the import graph, curated ruff and ty rules, the template (a uv project), its stages; the ty corpus. Starts at the freeze | The Python repo born green and through its first track; ty's coverage reported; the interface unchanged |

**Beads** (epic `monkeyshape-8il`; the roadmap's `070` and `gbx` close with it): `config`:
`8il.1` shape.toml, `8il.2` migrate, `8il.3` gate. `binary`: `8il.4` binaries, `8il.5`
install and launcher, `8il.6` ast-grep, `8il.7` hooks and text, `8il.20` spawning Bun,
`iwf`. `packs`: `8il.8` the interface, `8il.9` the TypeScript pack, `8il.10` ast-grep rules,
`8il.11` the ports, `8il.12` `init --pack`, `8il.13` two packs, `sgy`. `rust`: `8il.14`,
`8il.15`. `python`: `8il.16`, `8il.17`, `8il.18`. The acceptance and 0.6.0: `8il.19`.

**Order:** `config`'s loader first; `packs` and `rust` draft the interface together (by
message), `packs` freezes it, then `python` starts. `binary` needs nothing until its hooks
PR, which waits for `mshape gate`. The release waits for all five; the births wait for it.

## Decision points

- **The interface freeze:** above. If `rust` and `packs` disagree on a shape, `main` decides
  if it touches no goal; the maintainer otherwise.
- **ty's gaps:** if the corpus shows a class of defect neither ruff nor ty catches and no
  ast-grep rule can, the maintainer decides between living with it and a second checker.
- **Cargo's lints:** Cargo has no `extends`; whether `sync` owns the `[workspace.lints]`
  table in the root `Cargo.toml` or the template ships it once and a check compares it is
  `rust`'s call, reported in its PR.
- **Publishing 0.6.0** (npm and GitHub release assets) is the maintainer's.

## Deferred, with reasons

- Several-language init, dependencies between packs, Windows, other languages, package
  managers for the binary, `dlz`, `97o`, `v56`, `rrn`, `hh2`: see Non-goals.
- `3q2` (CI under a minute): the maintainer's call, 2026-11-18.
- `3a5` (a command for the amendments PR), `4sa.14` (per-track temp directory), `4sa.22`
  (a bun test root for shared paths), `5iq` (pulled beads by hook), `725`, `ede`: no track
  of this milestone needs them.

## Spend

None beyond ordinary sessions: no paid runs in this milestone's code. The ty corpus is code
already written by agents, not generated for it.

## Amendments

- **2026-11-18, `shape.config.ts` keeps loading until `8il.2` (`config`), approved by the
  planning session.** `8il.1` lands `shape.toml` with every row of its case table but one: a
  repo with only `shape.config.ts` still loads as today (`packs` defaulting to `typescript`),
  because `localRules`, their tests and `init` still use the TypeScript config until `packs`'
  `8il.10` and `8il.11` land. `8il.2` flips that row to "fails: run `mshape config migrate`",
  with its test, and moves check messages to kebab-case keys then. The end state is the plan's.
- **2026-11-18, Cargo's lints are a table `mshape sync` owns in the root `Cargo.toml`
  (`rust`, agreed with `packs`), approved by the planning session.** The copied-configs table
  gains the case the plan left to `rust`. A base config's delivery in `pack.ts` is `extends`,
  `copy` or `table`. Sync owns `[workspace.lints.rust]` and `[workspace.lints.clippy]`: the
  curated lints with `shape.toml`'s `[rust.lints.<tool>]` overrides laid over them, lint by
  lint. Cases, `rust`'s test:

  | Case | Result |
  |---|---|
  | the tables equal what sync writes, by parsed value | passes; a reformat isn't a failure |
  | a lint edited in `Cargo.toml` by hand | `sync` fails, naming the file: override in `shape.toml`, then `mshape sync` |
  | the tables missing | `sync` fails: run `mshape sync` |
  | a member crate without `[lints] workspace = true` | `packs/rust/member-lints` fails, naming the line to add |
  | a crate made by `cargo new` inside the workspace | has that line already (cargo 1.100) |

  Why: Cargo has no `extends`, and a `.mshape/` copy has nothing in Cargo to point at it.
- **2026-11-18, the pack interface is frozen (`packs`, #98; `rust`'s #102 builds on it
  unchanged), recorded by the planning session.** The frozen file is `src/packs/pack.ts` on
  `main` at 3ad637b, plus one optional field from #101: `fix?: string` on an unavailable
  integration, the fix to print when it isn't installing the tool (no Bun under the compiled
  binary). A pack is pure (`src/packs/<id>/`): `id`, `language`, `kindOf(file)` (source, test,
  declaration or none), `comments`, `syntaxErrors`, `defaultSources`, `hostSpecifiers`,
  `graph(input)` returning edges and host uses, `tools` with their coverage, `rules`,
  `findings` with declared `findingKinds` (reported as `packs/<id>/<kind>`), `baseConfigs`
  (`extends`, `copy` or `table`), `template`, `stages`, `prerequisites` and `loadFor`. Its
  loader (`src/adapters/packs/<id>.ts`) returns only tool runs and raw outputs. `pack.ts` is
  its own arch module, depending on schemas only. `python` starts now; from here a change to
  `pack.ts` is a divergence sent to `main` with why.
- **2026-11-18, the pack table's outcomes as built (`packs`, #98), approved by the planning
  session.** A file two listed packs claim is the `sources` finding `sources/claimed-twice`,
  naming the file and both packs, not a config failure: config load reads no files, and the
  fix is the same. Rows added beyond the table, each in `test/core/packs.test.ts`:

  | Case | Result |
  |---|---|
  | a listed pack this `mshape` doesn't ship | fails at config load |
  | a file in sources that no listed pack reads | `sources/unclaimed` |
  | an import into another listed pack's file | dropped: graphs are per pack |
  | a module sets `paths` | its files are those paths |
  | a pack reports a finding kind it didn't declare | `packs/undeclared-kind` |
