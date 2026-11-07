# monkeyshape roadmap

Where monkeyshape is heading, why, and how far it has got. The status table answers "does X
exist yet?". This file is direction, not a rule source: what ships is defined by the code,
`mshape --help`, `mshape rules`, the skills and `docs/workflow.md`. It follows its own
convention: rewritten in place at each milestone boundary, and never cited by code.

## Status

| Piece | Status |
|---|---|
| `mshape check`: arch, refs, budgets, coverage, skills, and five core rules (`mshape rules`) | **Shipped** (milestone 1) |
| `mshape baseline --tighten / --init` (ratchets in `.shape/baseline.json`), `garden`, `rules`, `--config` | **Shipped** (milestone 1) |
| Base `tsconfig` and `biome` configs in `config/`; the `decodeStrict` helper | **Shipped** (milestone 1) |
| `mshape init`: a new repo whose gate passes, with the template, beads, skills and the handoffs store | **Shipped** (milestone 1, `monkeyshape-iqf`) |
| `mshape track new / list / current / rm`: named tracks as worktrees, with handoffs | **Shipped** (milestone 1, `monkeyshape-iqf`) |
| `mshape review <n>` and `review rm`: a scratch worktree at a PR's head | **Shipped** (milestone 1, `monkeyshape-iqf`) |
| `mshape skills sync`, and the five skills: `roadmap`, `milestone`, `track`, `handoff`, `review-pr` | **Shipped** (milestone 1, `monkeyshape-iqf`) |
| `docs/workflow.md` (the working loop) and `docs/adopting.md` | **Shipped** (milestone 1, `monkeyshape-iqf`) |
| `mshape sync` (`skills sync` is its alias): shared skills, `.beads/PRIME.md` (what every session loads), the PR template and monkeyshape's hooks, with the `sync` check | **Shipped** (milestone 2, `monkeyshape-f4y`) |
| `mshape track pr` (a fresh gate, then open or update the PR) and `pr.yml`; `track list`'s derived `done` column; the `beads` check (who owns each bead) | **Shipped** (milestone 2, `monkeyshape-f4y`) |
| `mshape msg send / inbox / read / register`: the mailbox between tracks, with live notices into idle Claude Code sessions; `track rm --keep-beads` | **Shipped** (milestone 2, `monkeyshape-f4y`) |
| Conventions as code: one owner per checkable convention, delivered when needed, messages between tracks, derived status, review that reads the milestone | **Shipped** (milestone 2, `monkeyshape-f4y`); plan in `notes/2026-11-04-milestone-2.md` |
| Ready for a real application and a new repo: a gate whose pass means what it says, checks true on real layouts, adopter rules, no file silently overlooked, adoption as written | **Shipped** (milestone 3, `monkeyshape-xv2`, 0.4.0); plan in `notes/2026-11-07-milestone-3.md` |
| The loop at scale: a PR as one reviewed unit, rules where agents act, decisions that earn their slot, nothing private leaving the machine, tracks that start working, any step from anywhere | **Milestone 4** (draft): plan in `plan/MILESTONE.md` |
| First real adoptions: an existing application, and a new repo born through the loop | **Done** on 0.4.0: each ran its first milestone (`monkeyshape-36f`, `monkeyshape-iqf.14`) |
| The remaining starter rules | Later: `monkeyshape-hh2` |
| The agentic layer | Later: `monkeyshape-v56` |
| `mshape validate`: the real-data loop | Later: `monkeyshape-97o` |
| Effect: correct use in monkeyshape, and enforcement for adopters | Later: an epic filed with milestone 3 |
| Selectable policy bundles | Idea: when an outside adopter needs it (`monkeyshape-8h4`) |

"Shipped" means on `main`. npm has the release that shipped each milestone: 0.3.0 for
milestone 2, and 0.4.0 for milestone 3. A PR that ships a piece
updates its row.

## 0. Scope

monkeyshape describes one way for **humans and coding agents to build software together**
on **Bun, TypeScript, Effect and beads**. It is aimed mainly at repos that build agents or
agentic harnesses, but most of it applies to any repo with that stack.

It encodes a few beliefs:

- Humans set direction and agents own the code.
- Real-world data judges the work.
- A 95% solution shipped and measured beats a 100% solution planned.
- Mistakes become deterministic checks rather than prose.
- Anything loaded automatically into an agent's context is a scarce budget.

It is two things:

1. **A shared package** (`monkeyshape`, CLI `mshape`). It provides the checks, the custom lint
   rules, the small runtime helpers those rules point to, the base configs and the shared
   skills. A lesson learned in one adopting repo ships as a check, and every adopter gets it
   on its next version bump.
2. **A template** that `mshape init` copies.

Rules come in two **layers**:

- **core**: any repo on the stack.
- **agentic** (opt-in, not built yet): repos whose code calls models.

Each adopter keeps its local facts in one file, `shape.config.ts`: the module map, budget
overrides, allowlists that each carry a reason, and shared paths for tracks.

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

### Milestone 4: the loop at scale

Two repos ran on 0.4.0: an existing application adopted monkeyshape and ran its first
milestone with four parallel tracks, and a new repo was born and ran its first with three.
Their tracks found what only scale shows: PRs changed under their reviewers, rules stated
only in human docs, decisions with no test for what earns one, a private name in a public
PR body, worktrees that couldn't run their gate, and a human who had to change directory for
every step. Milestone 4 fixes those. The why and the plan are in `plan/MILESTONE.md`.

What milestone 3 taught: real adopters are the source of the next milestone, and their tracks
report precisely when asked. A plan's divergences need somewhere to go (they now go to `main`,
where the planning session stays open). What agents follow must be where they act (PRIME.md,
the skills, file headers, check messages); `docs/workflow.md` is for humans.

### The remaining starter rules (`monkeyshape-hh2`)

Planned core rules, each removing one bug class:

| Rule | Bug class it removes |
|---|---|
| Whole-file reads banned on data paths; stream instead | Silent truncation at size caps |
| No branching on an error's `.message`; tests assert `_tag` | Errors conflated by their message text |
| `as unknown as` needs a comment on the line above | Casts that hide type mismatches without explanation |
| No `*Id: string` fields; use branded ids | Mixed-up identifiers |
| No `sleep` in tests outside an allowlist | Slow or flaky tests |
| Every workflow id has an integration test | Untested glue code |

Domain types such as a branded address stay in the adopter.

### The agentic layer (`monkeyshape-v56`)

Opt-in rules and helpers for repos whose code calls models:

| Piece | Bug class it removes |
|---|---|
| Model output decoded only via `decodeModelOutput`, a lenient decoder backed by property tests | Shape breaks fixed one at a time: numbers sent as strings, a scalar where a list was expected, NaN |
| No model or provider names outside config | Hard-coded models |
| Paid runs go through a spend ledger with a daily cap; above it, a short run plan agreed with the human (question, expected cost, targets, what result would change the plan) | Unreviewed spend |

Evidence for a prompt or agent change is a run graded against the adopter's evaluation set.

### Effect: guarantees, not style (epic filed with milestone 3)

Effect belongs where it buys an execution guarantee: typed operational failures,
cancellation, resource lifetimes, concurrency supervision, dependency composition and
testability. Pure transformations, parsers and deterministic analysis stay ordinary
TypeScript. monkeyshape keeps its shape (a pure core, operational adapters, schemas for
contracts, execution at composition roots) and works in two directions that inform each
other: its own Effect use (subprocess cancellation, resource cleanup, typed failures,
interruption and failure-injection tests), and enforcement for adopters (rule corrections,
type-aware diagnostics tried through Effect's own tooling before any syntax heuristic,
execution boundaries declared in the existing module map, checks for recurring resource and
concurrency mistakes). A real bug fixed in one becomes a regression test or a rule in the
other. It waits for a reproduced failure on an adopter's path.

### `mshape validate` (`monkeyshape-97o`)

The real-data loop as a command: checks run against named targets (a location and a content
hash) and compared with committed baselines, one line per check (pass, regress, improve).
Required on PRs that touch core logic, with its table in the PR body; baselines change only
in the PR whose code moves them. This is what turns "real data is the judge" from a habit
into a gate.

### Policy bundles (`monkeyshape-8h4`)

Correctness checks always on; workflow opinions opt-out as a bundle. Built only when an
outside adopter needs it.

### Dependencies between repos

Repos stay separate: a foundation library serves many applications. Milestone 3 ships the
first part, a release tarball with its hash and `mshape dep bump`. Still to come: upstream
releases that smoke-test their consumers' real workflows.

### Gate hardening (no epic yet)

Planned for the gate and not built: pre-push and pre-commit hooks running the gate (or a
fast part of it), branch protection on `main` requiring a PR and a green `check`, a
meta-check that rejects biome excludes other than generated or vendor paths, and compiling
any non-TypeScript code in the repo. Each closes a way for red code to reach `main`.
