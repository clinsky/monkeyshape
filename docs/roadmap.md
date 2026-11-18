# monkeyshape roadmap

Where monkeyshape is heading, why, and how far it has got. The status table answers "does X
exist yet?". This file is direction, not a rule source: what ships is defined by the code,
`mshape --help`, `mshape rules`, the skills and `docs/workflow.md`. It follows its own
convention: rewritten in place at each milestone boundary, and never cited by code.

## Status

Goals not yet shipped are listed in the order they would be taken.

| Goal | Status | Epic |
|---|---|---|
| A new repo can be born: `mshape check`, baselines, `init`, tracks, review worktrees, the five skills | **Shipped** (milestone 1) | `monkeyshape-iqf` |
| Conventions as code: `mshape sync`, PRIME.md, `track pr`, the mailbox, derived status | **Shipped** (milestone 2, 0.3.0) | `monkeyshape-f4y` |
| Ready for a real application and a new repo: a gate whose pass means what it says, adopter rules | **Shipped** (milestone 3, 0.4.0) | `monkeyshape-xv2` |
| First real adoptions: an existing application, and a repo born through the loop | **Done** on 0.4.0 | `monkeyshape-36f` |
| The loop at scale: a PR as one reviewed unit, rules where agents act, the denylist, tracks that start working | **Shipped** (milestone 4, 0.5.0) | `monkeyshape-4sa` |
| A language-neutral core: config as data, a configurable gate, a pinned binary, the pack interface | **In progress** (milestone 5) | `monkeyshape-070` |
| Language packs: Rust and Python | **In progress** (milestone 5) | `monkeyshape-gbx` |
| Harness adapters: Codex and pi | Later: milestone 6 | `monkeyshape-dlz` |
| `mshape validate`: the real-data loop (core) | Later | `monkeyshape-97o` |
| The remaining starter rules (TypeScript pack) | Later | `monkeyshape-hh2` |
| The agentic layer: spend ledger (core), model-output decoding (per pack) | Later | `monkeyshape-v56` |
| Effect: guarantees, not style (TypeScript pack) | Later | `monkeyshape-rrn` |
| Gate hardening | Later: when a failure shows the need | `monkeyshape-nm9` |
| Dependencies between repos: releases that smoke-test their consumers | Idea: when the adopter probe by hand stops being enough | `monkeyshape-a09` |
| Selectable policy bundles | Idea: when an outside adopter needs it | `monkeyshape-8h4` |

"Shipped" means on `main`; the plans of milestones 1 to 4 are in `notes/`, milestone 5's in
`plan/MILESTONE.md`. A PR that ships a goal updates its row.

## 0. Scope

monkeyshape describes one way for **humans and coding agents to build software together**:
a **language-neutral core** of beads and the working loop (tracks, handoffs, the mailbox,
PRs, review, budgets), plus a **language pack** per stack and a **harness adapter** per
coding agent. It is aimed mainly at repos that build agents or agentic harnesses, but most
of it applies to any repo.

What stays fixed for every repo, whatever its language or harness: beads and the working
loop. What varies: the toolchain, the module boundaries, the rules and the gate (the pack),
and how a session loads the loop and receives mail (the adapter). Bun is a build detail of
the `mshape` binary; Effect is the TypeScript pack's opinion. Today only the TypeScript pack
and the Claude Code adapter exist, fused into the core; milestones 5 and 6 separate them.

It encodes a few beliefs:

- Humans set direction and agents own the code.
- Real-world data judges the work.
- A 95% solution shipped and measured beats a 100% solution planned.
- Mistakes become deterministic checks rather than prose.
- Anything loaded automatically into an agent's context is a scarce budget.

It is two things:

1. **A shared tool** (`mshape`) and, per pack, what an adopter's code imports or extends: the
   checks, the custom rules, the small runtime helpers those rules point to, the base configs
   and the shared skills. A lesson learned in one adopting repo ships as a check, and every
   adopter of that pack gets it on its next version bump.
2. **A template per pack** that `mshape init` copies.

Rules come in two **layers** (the `layers` config value): `core`, for any repo of a pack, and
`agentic` (opt-in, not built yet), for repos whose code calls models. The `core` layer is a
pack's rule set; it is not the language-neutral core above.

Each adopter keeps its local facts in one config file: the module map, budget overrides,
allowlists that each carry a reason, and shared paths for tracks. Today that is
`shape.config.ts`; milestone 5 makes it data.

**Not in scope** until a consumer asks: Windows, languages other than TypeScript, Rust and
Python, and harnesses other than Claude Code, Codex and pi.

## 1. Principles

Every rule must trace back to one of these principles. A rule that can't is deleted.

1. **Humans own direction; agents own the code.** Humans and agents work out requirements
   and priorities together. Agents own every line of code, test and in-repo document, so no
   in-repo text is written "for a human". Humans read the *narrative*: PR bodies, commit
   messages, handoffs and milestone plans. Effort on prose goes there.
2. **Real data is the judge.** A change is done when it has run on real targets and someone
   has read the result. Passing tests is not enough. Ship the 95% version, measure it, and
   then decide what the remaining 5% is worth. Small synthetic fixtures miss the bugs that
   scale and real inputs expose.
3. **Mechanism over prose.** A mistake worth generalizing becomes a check that rules out its
   whole class. Prose is fragile: it only works when it is loaded and when an agent notices it
   applies, among a hundred other files. In practice, bug classes recur even after being
   written down in several documents. A check costs no context and needs no recall. Prose is
   the last resort, and must say why it can't be a check.
4. **Written text is a hypothesis; code and data are the truth.** Every ticket, plan and
   decision is a dated claim by someone who knew less than you do now. When text conflicts
   with the code, real data or common sense, fix the text and carry on. Escalate only when
   the decision belongs to a human. This guards against agents treating old decision records
   or ticket wording as gospel.
5. **One home per fact.** If a fact is stated twice, one copy is going stale, and a doc that
   restates another doc copies its errors forward. Link, don't restate. Code may cite only
   what a check can verify.
6. **Salience is a budget.** Everything loaded automatically has a hard cap, enforced by the
   gate. Too many rules, decisions or memories and none of them stands out. Pruning is a
   routine step at every milestone boundary, not an emergency cleanup. A check is silent
   until violated, so it is cheap to keep; prose costs every session, so pruning it is
   mandatory.
7. **Plan in three horizons, and commit in detail only to the nearest.** Direction is
   months ahead and coarse on purpose; a milestone is detailed and frozen; track state is
   live. Breaking far-off goals into dozens of high-priority stories on day 1 crowds out the
   real queue and describes work that events will overtake. How the horizons work is in
   `docs/workflow.md`.
8. **Build for a consumer, on agent timelines.** No framework feature ships before a consumer
   asks for it. Design with the second consumer in mind, but build for the first. When hard
   work lines up with current priorities, do it now. Agent time is cheap, and carrying a
   design you know is wrong is not.


## 2. Direction

### What milestone 4 taught

Two repos ran on 0.4.0 at scale (four and three parallel tracks) and their reports drove
milestone 4 (`notes/2026-11-18-milestone-4.md`). Real adopters stay the source of the next
fixes, and their tracks report precisely when asked. What agents follow must be where they
act (PRIME.md, the skills, file headers, check messages). Milestone 5 (`plan/MILESTONE.md`)
takes the next goal in order.

### A language-neutral core (`monkeyshape-070`, milestone 5)

**Intent.** Separate what every repo shares from what its language decides, so a repo with no
JavaScript can run the loop and the gate.

- **Config as data:** `shape.toml`, validated by a schema, replaces `shape.config.ts`. The two
  adopters and this repo migrate once, by a command; no second config format is kept.
- **The gate is configured,** not hard-coded as `bun run check`: PRIME.md, the skills, the PR
  template, `track pr` and CI read it from config.
- **`mshape` ships as a compiled binary** (Bun compiles it; Bun is a build detail), as GitHub
  release assets with hashes for Linux x64 and arm64 and macOS arm64. `shape.toml` pins the
  version and hash; a small committed bootstrap fetches and verifies it. A non-TypeScript
  repo has no `package.json` and no `node_modules`. npm keeps shipping what TypeScript code
  imports or extends (`decodeStrict`, the base `tsconfig` and biome configs).
- **A language-pack interface,** with TypeScript refactored into the first pack.
- **Adopter rules through ast-grep, for every language.** TypeScript `localRules` (functions
  in `shape.config.ts`) are ported once, the adopters' included, and removed. monkeyshape's
  own TypeScript core rules stay on oxc inside the TypeScript pack. ast-grep is a new runtime
  dependency, approved in principle; how it is delivered (bundled with the release or pinned
  beside it) is the milestone's call.

**Consumer.** The Rust and Python repos the maintainer starts as soon as milestone 5 ships,
with no workaround in between; and the two existing adopters, which must stay green across
the migration.

**Done looks like:** the language-packs goal's acceptance below; this goal has none apart
from it, since an interface is proven only by the packs that fill it.

**Why now.** Both waiting repos need it, and every later goal is cheaper on a neutral core:
validate and the agentic layer's ledger are core, the starter rules and Effect are the
TypeScript pack's. It is planned with the language packs as one milestone, so the interface
is shaped by TypeScript and Rust rather than guessed, and tested by Python, which must fit it
unchanged: the interface is settled from the first two before the Python pack is built on it.

**Learned so far.** The checks are already pure functions over a `Snapshot` with adapters
loading it, so many of them (budgets, refs, files, skills, sync, beads, decisions) should
be neutral once their inputs are; arch's import graph and the oxc rules are TypeScript's.
The loop's own text names Bun: PRIME.md tells agents `bun run --silent mshape ...`, and the
Claude Code hooks look for `bun` on the PATH (missing after a restart in three sessions that
milestone 4 answered). A binary removes both.

### Language packs: Rust and Python (`monkeyshape-gbx`, milestone 5)

**Intent.** Each pack fills the interface: source and toolchain authority, module
boundaries, its `core`-layer rules, base-config delivery, adopter rules (ast-grep), the init template
and the gate.

- **Rust:** `cargo metadata` for sources and the crate graph as module boundaries; clippy and
  rustfmt; curated workspace lints. Cargo has no cross-repo `extends`, so `mshape sync`
  copies the base config in and the `sync` check keeps it equal.
- **Python:** uv, ruff, ty, pytest; the import graph as module boundaries; curated ruff rules, delivered by `extend` where it reaches or
  copied by sync where it doesn't.

**Consumer.** The maintainer's next Rust repo and next Python repo, both born with
`mshape init` once this ships. Neither starts before.

**Done looks like:** a real Rust repo and a real Python repo born green with no JavaScript
anywhere in them (no `package.json`, no `node_modules`, no Bun), each running its first
track through the loop; both existing adopters still green on the new release; and Python
fitting the pack interface without changing it. A change to the interface for Python is
the signal that the interface was shaped by TypeScript and Rust alone.

**Why now.** Same milestone as the core, by the maintainer's choice: the repos wait for both,
and a second and third pack are what test the interface.

**Chosen at milestone 5's boundary.** ty over basedpyright and mypy, the maintainer's call:
native and fast, no Node in the toolchain, and one ecosystem with uv and ruff. It is young, so
it is pinned and its coverage is measured on real agent-written Python. A repo of several
languages will be needed: the interface takes a list of packs and a test composes two, and
`init` for several packs waits for its consumer.

**Out of scope:** languages other than these, Windows, and porting monkeyshape's own
TypeScript rules to ast-grep.

### Harness adapters: Codex and pi (`monkeyshape-dlz`, milestone 6)

**Intent.** A neutral floor every harness gets, with no harness-specific mechanism: AGENTS.md,
`mshape prime`, skills as markdown, mail pulled by command. Then Claude Code refactored into
the first adapter on that floor, and adapters for Codex and pi: hooks, where skills live,
session identity, and push notices through the existing `Notifier` where the harness supports
one.

**Consumer.** Agents running in Codex and pi on the maintainer's repos.

**Done looks like:** a track worked end to end in Codex and in pi (session start loads the
loop, mail arrives, a PR opens through `track pr`), with Claude Code behaving as on 0.5.0.

**Why later.** No Codex or pi user yet, while two repos wait on the packs. If one arrives
before the Python repo, it swaps with milestone 5; nothing in it depends on the packs.

**Learned so far.** Claude Code is woven in today: the `.claude/skills` symlink, the
`.claude/settings.json` hooks, `CLAUDE_CODE_SESSION_ID` for registration, and live notices
over Claude Code's undocumented socket (`notes/2026-11-03-spike-native-delivery.md`).
Skills already live in `.agents/skills`, which Codex reads.

**Out of scope:** Cursor and any other harness.

### `mshape validate` (`monkeyshape-97o`, core)

The real-data loop as a command: checks run against named targets (a location and a content
hash) and compared with committed baselines, one line per check (pass, regress, improve).
Required on PRs that touch core logic, with its table in the PR body; baselines change only
in the PR whose code moves them. This turns "real data is the judge" from a habit into a
gate. Language-neutral: it belongs to the core, so it waits for milestone 5's split.

### The remaining starter rules (`monkeyshape-hh2`, TypeScript pack)

Planned TypeScript rules, each removing one bug class; the other packs get their own
equivalents when a consumer hits the class:

| Rule | Bug class it removes |
|---|---|
| Whole-file reads banned on data paths; stream instead | Silent truncation at size caps |
| No branching on an error's `.message`; tests assert `_tag` | Errors conflated by their message text |
| `as unknown as` needs a comment on the line above | Casts that hide type mismatches without explanation |
| No `*Id: string` fields; use branded ids | Mixed-up identifiers |
| No `sleep` in tests outside an allowlist | Slow or flaky tests |
| Every workflow id has an integration test | Untested glue code |

Domain types such as a branded address stay in the adopter.

**Why later:** each rule waits for a TypeScript adopter to hit its bug class, and lands in
the TypeScript pack once milestone 5 has made one.

### The agentic layer (`monkeyshape-v56`)

Opt-in rules and helpers for repos whose code calls models:

| Piece | Where | Bug class it removes |
|---|---|---|
| Model output decoded only through a lenient decoder backed by property tests (`decodeModelOutput` in TypeScript) | each pack | Shape breaks fixed one at a time: numbers sent as strings, a scalar where a list was expected, NaN |
| No model or provider names outside config | each pack | Hard-coded models |
| Paid runs go through a spend ledger with a daily cap; above it, a short run plan agreed with the human (question, expected cost, targets, what result would change the plan) | the neutral core | Unreviewed spend |

Evidence for a prompt or agent change is a run graded against the adopter's evaluation set.

**Why later:** it waits for an adopter whose code calls models to ask for it; its ledger
needs the neutral core of milestone 5, so it works in every language.

### Effect: guarantees, not style (`monkeyshape-rrn`, TypeScript pack)

Effect belongs where it buys an execution guarantee: typed operational failures,
cancellation, resource lifetimes, concurrency supervision, dependency composition and
testability. Pure transformations, parsers and deterministic analysis stay ordinary
TypeScript. Two directions that inform each other: monkeyshape's own Effect use (subprocess
cancellation, resource cleanup, typed failures, interruption and failure-injection tests),
and enforcement for TypeScript adopters (rule corrections, type-aware diagnostics tried
through Effect's own tooling before any syntax heuristic, execution boundaries declared in
the module map, checks for recurring resource and concurrency mistakes). A real bug fixed in
one becomes a regression test or a rule in the other. It waits for a reproduced failure on an
adopter's path.

### Gate hardening (`monkeyshape-nm9`)

Planned for the gate and not built: pre-push and pre-commit hooks running the gate (or a
fast part of it), branch protection on `main` requiring a PR and a green `check`, a
meta-check that rejects lint excludes other than generated or vendor paths, and compiling
any code in the repo outside its pack's language. Each closes a way for red code to reach
`main`; each is built when a failure shows the need.

### Dependencies between repos (`monkeyshape-a09`)

Repos stay separate: a foundation library serves many applications. Milestone 3 shipped the
first part for TypeScript, a release tarball with its hash and `mshape dep bump`. Still to
come, when a consumer needs it: upstream releases that smoke-test their consumers' real
workflows, and the same for the other packs.

**Why later:** the only such pair today is monkeyshape and its adopters, where review's
adopter probe does the smoke test by hand; it is built when that stops being enough, or when
a second upstream appears.

### Policy bundles (`monkeyshape-8h4`)

Correctness checks always on; workflow opinions opt-out as a bundle. Built only when an
outside adopter needs it.
