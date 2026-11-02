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
| Conventions as code: one owner per checkable convention, delivered when needed, messages between tracks, derived status, review that reads the milestone | **Milestone 2** (in progress): `monkeyshape-f4y`, plan in `plan/MILESTONE.md` |
| First real adoption: a new repo born through the loop | **After milestone 2**: `monkeyshape-iqf.14` |
| The remaining starter rules | Later: `monkeyshape-hh2` |
| The agentic layer | Later: `monkeyshape-v56` |
| `mshape validate`: the real-data loop | Later: `monkeyshape-97o` |
| Adopting monkeyshape in an existing repo, with a migration guide | Later: `monkeyshape-36f` |
| Selectable policy bundles | Idea: when an outside adopter needs it (`monkeyshape-8h4`) |

A PR that ships a piece updates its row.

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
7. **Plan in three horizons, and commit in detail only to the nearest.** See below.
8. **Build for a consumer, on agent timelines.** No framework feature ships before a consumer
   asks for it. Design with the second consumer in mind, but build for the first. When hard
   work lines up with current priorities, do it now. Agent time is cheap, and carrying a
   design you know is wrong is not.

## 2. The three horizons

How they work day to day is in `docs/workflow.md`; this is what each is for.

- **Direction (months)** is this file plus one deferred epic per goal. It is coarse on
  purpose: the brainstorm and far-off detail live here, not as dozens of high-priority
  stories filed on day 1 that crowd out the real queue and describe work overtaken by
  events. The status table comes first so nobody builds to it as if it were a spec.
- **A milestone (weeks)** is the next significant delivery, several PRs from several parallel
  agents, planned in detail and frozen so tracks can work against a fixed target.
- **Track state (today)** is one live handoff per parallel track, so a fresh-context agent
  can continue and the human can see what to relay.

The milestone boundary is the only ceremony; between boundaries, tracks work their queues.

## 3. Direction

### Milestone 2: conventions as code (`monkeyshape-f4y`)

Milestone 1 applied mechanism-over-prose to code but shipped the loop's own conventions as
prose, and they decayed as the principles predict. Milestone 2 gives each checkable
convention one owner in code, delivers each at the moment it is needed, and derives status
from git, PRs and beads instead of recording it by hand. The why and the plan are in
`plan/MILESTONE.md`.

### First real adoption (`monkeyshape-iqf.14`)

A new repo born through `mshape init` and worked through the whole loop. It comes after
milestone 2 so it tests the loop, not contradictions we already know about. Its first
milestone is "a first result on a real target".

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

### `mshape validate` (`monkeyshape-97o`)

The real-data loop as a command: checks run against named targets (a location and a content
hash) and compared with committed baselines, one line per check (pass, regress, improve).
Required on PRs that touch core logic, with its table in the PR body; baselines change only
in the PR whose code moves them. This is what turns "real data is the judge" from a habit
into a gate.

### Adopting an existing repo (`monkeyshape-36f`)

Today `docs/adopting.md` covers installing, trying the checks with `--config` and
grandfathering violations with `baseline --init`. The goal is a migration guide for a repo
with history: adopt at a sync point, after parallel work finishes its current PRs, with one
knowledge-migration PR that reshapes docs, decisions, memories, handoffs and beads, and
code-level rules landing as ratchets so in-flight work sees no churn.

### Policy bundles (`monkeyshape-8h4`)

Correctness checks always on; workflow opinions opt-out as a bundle. Built only when an
outside adopter needs it.

### Dependencies between repos (no epic yet)

Repos stay separate: a foundation library serves many applications. The idea is internal
dependencies shipped as release tarballs, a command that bumps one (verify its hash, update
the lockfile, run the gate), and upstream releases that smoke-test their consumers' real
workflows. It waits for a second repo that depends on another.
