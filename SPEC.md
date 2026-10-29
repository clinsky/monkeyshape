# monkeyshape: spec (draft 2)

> This is a working draft. Once built, it becomes the package, the template and a short
> AGENTS.md, and this file is deleted.

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
2. **A template** that `mshape init` copies: layout, AGENTS.md, DECISIONS.md, PR template,
   CI, hooks and beads config.

Rules come in two **layers**:

- **core**: any repo on the stack.
- **agentic** (opt-in): repos whose code calls models. It covers lenient decoding of model
  output, spend controls, graded evaluation runs and keeping model names in config.

The repo root is the package. Its layout is `shape.config.ts`; v0.1 has `src/core` (the
checks and rules, pure), `src/adapters` (disk, git, bd), `src/helpers` (decodeStrict),
`src/cli` (`mshape check | baseline | garden | rules`) and `config/` (the base tsconfig and
biome config adopters `extends`). `template/` and `skills/` arrive in v0.2 and v0.3.

Each adopter keeps its local facts in a single file, `shape.config.ts`. It holds the module
map (module → mayImport, hostAccess, packages), which layers are on, budget overrides,
allowlists that each carry a reason, and its real-data targets.

## 1. Principles

Every rule must trace back to one of these principles. A rule that can't is deleted.

1. **Humans own direction; agents own the code.** Humans and agents work out requirements
   and priorities together. Agents own every line of code, test and in-repo document, so no
   in-repo text is written "for a human". Humans read the *narrative*: PR bodies, commit
   messages, handoffs and milestone plans (§2). Effort on prose goes there.
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
   §7 says the call belongs to a human. This guards against agents treating old decision
   records or ticket wording as gospel.
5. **One home per fact.** If a fact is stated twice, one copy is going stale, and a doc that
   restates another doc copies its errors forward. Link, don't restate. Code may cite only
   what a check can verify (§3.3).
6. **Salience is a budget.** Everything loaded automatically has a hard cap, enforced by the
   gate. Too many rules, decisions or memories and none of them stands out. Pruning is a
   routine step at every milestone boundary (§8), not an emergency cleanup.
7. **Plan in three horizons, and commit in detail only to the nearest.** Direction is
   long-term and coarse. A milestone is mid-term and detailed. Track state is short-term and
   live (§2.1).
8. **Build for a consumer, on agent timelines.** No framework feature ships before a consumer
   asks for it. Design with the second consumer in mind, but build for the first. When hard
   work lines up with current priorities, do it now. Agent time is cheap, and carrying a
   design you know is wrong is not.

## 2. Where knowledge lives

| Kind | Home | Loaded automatically | Kept true by |
|---|---|---|---|
| A rule a machine can check | **A check.** Its error message gives the reason and the fix | No; it speaks only when violated | The gate |
| A domain invariant | **A test named after the invariant** | No | The gate |
| The local reason for some code | **A comment at that code** | When the file is read | Being next to the code |
| A live architectural decision | **`DECISIONS.md`** (§3.1) | No; linked from AGENTS.md | Schema check, overwrite rule |
| Commands, gotchas, where to start | **AGENTS.md** (§3.2) | Yes | Budget and refs checks |
| A human quickstart | **README.md**: 80 lines or fewer, no status | No | Refs check |
| **Direction** (long-term) | **Deferred direction epics in beads** | No | Re-read at each milestone plan |
| **Milestone** (mid-term) | **`plan/MILESTONE.md`** (§3.5) | No | Replaced at each milestone |
| **Track state** (short-term) | **Handoffs** in a shared live directory (§3.6) | Read at session start | Overwritten at each handoff |
| What a change did and what it showed | **PR body and commit messages** | No | Written once, at the time |
| A unit of work | **Beads**, short and dated (§6.3) | Only the titles from `bd ready` | Grooming |
| Deep investigations, measurement write-ups | **`notes/YYYY-MM-DD-slug.md`**: immutable, historical | No | Nothing; notes are allowed to age |
| Principles that span sessions | **bd memories**: 12 at most, principles only | Yes | Budget check, grooming |

### 2.1 The three horizons

- **Direction (long-term).** Where the repo is heading over months. Each direction is a beads
  epic with a goal and a few lines on why. It is **deferred**, so it never appears in
  `bd ready`, and it has **no child stories** until a milestone pulls it in. Long-lived open
  epics are fine. The failure mode is breaking far-future epics into dozens of stories on
  day 1, all at high priority, which then crowd out the real queue and describe work that has
  been overtaken by events.
- **Milestone (mid-term).** The next significant delivery: roughly several PRs from each of
  several parallel agents. It is planned in a human–agent conversation and written to
  `plan/MILESTONE.md`. Beads are then **groomed** to match: the milestone's stories are
  created, and the stories it supersedes are closed or deferred with a reason.
- **Track state (short-term).** One handoff per parallel track. A fresh-context agent reads
  it to know exactly where to continue, and the human reads it to decide when to hand off and
  what to relay between tracks.

The **milestone boundary** is where the routine process happens: delivery, retrospective,
the next milestone plan, grooming, then the garden sweep (§8). Between boundaries there is no
ceremony. Tracks work their queues, and PR bodies record what was learned.

### 2.2 What this replaces

| Replaced | Replacement |
|---|---|
| Numbered ADR directories, append-only "Update" sections, superseded stubs | A capped `DECISIONS.md` that is overwritten in place, plus tests, checks and comments |
| A "living" design brief | Design briefs go in `notes/` as history from day 1. Their goals become direction epics |
| Git-tracked handoffs | A shared live directory. Git-tracked handoffs fork per worktree, so the copy on main goes stale |
| Tool instructions duplicated across CLAUDE.md, AGENTS.md, skills and editor rules | One source each |
| AGENTS.md restating decisions | Links to `DECISIONS.md` |
| Committing the beads export | Sync through the Dolt remote |

### 2.3 Why `notes/` exists

Agents will write investigations whatever the rules say, and those write-ups have value.
Without a home they leak into decision records, oversized tickets and AGENTS.md. Notes in
`notes/` are:

- **immutable and dated**: you write a new note instead of updating an old one.
- **non-normative**: code, AGENTS.md, DECISIONS.md and tests may not link to them. Beads, PR
  bodies, handoffs and the milestone plan may.
- **never loaded automatically.**

A lesson that should apply going forward is promoted to a check, a test or a decision.

## 3. Documents

### 3.1 `DECISIONS.md`: live decisions only

- **Size limits:** at most 15 entries of at most 150 words each, enforced by the gate. IDs
  are slugs (`D-address-space`), never numbers.
- **Overwrite, never append.** To reverse a decision, rewrite its entry; git keeps the
  history. Nobody should have to read a chain of records in order to learn the current
  answer.
- **Fixed fields**, checked by script:
  ```md
  ## D-address-space: Addresses are (space, offset), never a bare number
  Decision: …1–2 sentences…
  Tempting wrong fix: …what a capable agent would do instead, and why it fails…
  Evidence: measured | verified | policy: …one line, link to a note or PR…
  Enforced by: src/schemas/address.ts (branded type), test/invariants/address.test.ts
  Revisit when: …a concrete trigger…
  ```
- **Required paths and status:** "Enforced by" must point to paths that exist. An entry with
  nothing enforcing it is marked `policy`. "Revisit when" marks the entry as a default backed
  by evidence, not law.
- **What qualifies:** a surprising external fact that has been measured, or a choice between
  real alternatives that would be expensive to undo. The most valuable entries name the
  tempting wrong fix. A feature design does not qualify; it goes in the code and its module
  header.

### 3.2 AGENTS.md: at most 150 lines

Sections, in this order:

1. Purpose
2. Commands
3. Where to start (points to `shape.config.ts` for the layout)
4. Gotchas, each naming its guarding check or test, or saying why it can't have one
5. Rules that aren't mechanical, each with its principle and why it can't be a check
6. Decision authority (§7)
7. Working agreements, about 15 lines

It holds no status, feature descriptions, layout listings, history, restated decisions, or
rules attributed to a person and a date. CLAUDE.md contains only `@AGENTS.md`.

### 3.3 The refs check (`mshape check refs`)

It scans AGENTS.md, README, DECISIONS.md, skills, the PR template and code comments, and
fails on any of these:

- a backticked path, a `bun run X` or a `D-slug` that doesn't exist;
- a link from code or normative docs into `notes/`, `plan/` or a handoff;
- `§N`-style citations;
- a bead id cited from code, except in a `TODO(bd-xxx)`. Ids are checked against `bd list`,
  so lookalike names aren't flagged; without `bd` (CI) the rule doesn't run and its baseline
  entries are left alone. Grooming flags the TODO once its bead closes.

### 3.4 Skills

Skills are procedural and self-contained. Each states when it expires or should be reviewed,
and each is covered by the refs check. A skill never restates AGENTS.md or DECISIONS.md.
Shared skills come from the package; skills specific to one repo live in that repo.

### 3.5 `plan/MILESTONE.md`: the mid-term plan

- **Sections:**
  - Goal, and how we'll know (acceptance on real targets)
  - Where we are, measured (a gap table)
  - What changed since the last milestone, and why
  - Tracks: charter, ordered beads, acceptance, interfaces between tracks
  - Decision points
  - Spend plan for big runs (§7)
  - Deferred items, each with a reason
- **Frozen for its milestone.** When a track diverges from it, the track records that in its
  handoff. A divergence that affects other tracks or the goal triggers a conversation with
  the human, not a rewrite of the plan.
- **Replaced at the boundary.** The old plan moves to `notes/`.
- **About 500 lines** is a soft cap. Revision history lives in git, not in the document.
- **Who may cite it:** only handoffs and beads.

### 3.6 Handoffs: shared, live, readable by the human

- **Location:** `~/<workspace>/<repo>-state/handoffs/`, outside git. `mshape worktree new
  <track>` creates the worktree and symlinks `.handoffs/` (and any data directories listed in
  `shape.config.ts`) into it. Every worktree and the human see one live copy. Handoffs are
  never committed, so they can't fork. They are ephemeral by design; PR bodies are the durable
  record.
- **Shape**, about 120 lines as a soft cap:
  - Header: track, epic, queue command, the milestone sections this track owns
  - State, dated and overwritten: done, in flight, next
  - Lessons not yet promoted
  - Traps specific to this track
  - Messages to and from other tracks and the human
- **Lessons not yet promoted:** a staging area. Grooming promotes each lesson to a check, test,
  gotcha or decision, or deletes it.
- **When to hand off:** at a natural break, around 75% of the context window. Use judgement,
  not the exact number.

## 4. Mechanical enforcement

### 4.1 The gate: `bun run check`, the same in CI as locally, about 90 seconds

The gate runs, in order:

1. `tsc` over everything.
2. `biome ci --error-on-warnings` over everything. A meta-check rejects excluding anything
   other than generated or vendor paths.
3. `mshape check`: arch, refs, budgets, ratchets and the custom rules.
4. `bun test`, with quiet logging.
5. Compilation of any non-TypeScript code in the repo.

**Hooks:** pre-push runs the full gate; pre-commit runs biome and arch. **Branch protection:**
main requires a PR and a green `check`.

### 4.2 Starter rule set

**tsconfig:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noPropertyAccessFromIndexSignature`, `noImplicitOverride`, `noImplicitReturns`,
`noFallthroughCasesInSwitch`, `noUnused*`, `allowUnreachableCode: false`,
`allowUnusedLabels: false`, `verbatimModuleSyntax`, `erasableSyntaxOnly`,
`isolatedModules`, `noUncheckedSideEffectImports`.

**Biome built-in rules:**
- noExplicitAny, noNonNullAssertion, noEnum, noNamespace, noParameterAssign
- useImportType and useExportType
- noBarrelFile and noReExportAll (except the public `src/api`)
- useImportExtensions
- noConsole (outside `cli/` and `tools/`)
- noFloatingPromises and noMisusedPromises
- banned globals outside the composition root: `Date.now`, bare `new Date()`, `Math.random`,
  `setTimeout`, `process.env` and `Promise.all/race`

**Custom rules (core):**

| Rule | Bug class it removes |
|---|---|
| `throw` and `extends Error` only in an allowlist | Mixed error paradigms |
| `Effect.run*` only in entry, CLI and testkit files | Nested runtimes that lose interruption and context |
| Decoding only via `decodeStrict` | Unknown keys silently dropped |
| Whole-file reads banned on data paths; use `readStream` | Silent truncation at size caps |
| No object spread of error values | Lost `cause` |
| No branching on `.message`; tests assert `_tag` | Errors conflated by their message text |
| `as unknown as` needs a comment on the line above | Casts that hide type mismatches without explanation |
| No `*Id: string` fields in `src`; use branded ids | Mixed-up identifiers |
| No `sleep` in tests outside an allowlist | Slow or flaky tests |
| Every workflow id has an integration test | Untested glue code |

**Custom rules (agentic layer):**

| Rule | Bug class it removes |
|---|---|
| Model and agent output decoded only via `decodeModelOutput`, a lenient decoder backed by property tests | Shape breaks fixed one at a time: numbers sent as strings, a scalar where a list was expected, NaN |
| No model or provider names outside config | Hard-coded models |
| Paid runs go through the harness's spend ledger | Unreviewed spend |

**Domain types** stay in the adopter, for example a branded `Address`, so that arithmetic
across address spaces fails to type-check.

### 4.3 How rules grow and shrink

- **The lesson loop.** The PR template has a required `Class closed by:` line. If a check
  can remove the bug class, the check ships in the same PR. If the check is general, it
  ships upstream in monkeyshape, so quality compounds across every adopter.
- **Ratchets.** A new rule can land with a baseline of existing violations per file
  (`.shape/baselines/<rule>.json`). Counts can only go down, so adopting a rule never needs a
  big-bang cleanup.
- **The rule registry.** Each rule records an id, its bug class, a short public description
  of the incident class it came from, an error message giving the reason and the fix, and
  positive and negative fixtures.
- **Pruning.** A check is silent until violated, so it is cheap to keep. Prune a check only
  for false positives, or when its bug class has become impossible. Prose costs every
  session, so pruning prose is mandatory. Every escape hatch carries a reason and is counted.

## 5. Repo layout

`shape.config.ts` defines the layout, and nothing restates it.

```
AGENTS.md (≤150)  CLAUDE.md ("@AGENTS.md")  README.md (≤80)  DECISIONS.md (≤15)
shape.config.ts
src/
  schemas/        pure data contracts
  core/<domain>/  deterministic logic, no host I/O
  adapters/       host/process/backend/model I/O behind Effect services
  workflows/      one file per workflow id, thin
  api/            sole public surface (for libraries)
  cli/
tools/            operator scripts: typechecked, linted and tested like src
validate/         real-data loop: checks/<name>.ts, targets (id → location + content hash), baselines/
bench/            agentic layer: eval cases with expected answers
test/             unit/ golden/ integration/ invariants/ live/ (env-gated)
plan/MILESTONE.md
notes/
.handoffs →       shared state dir (symlink, gitignored)
out/              gitignored output
```

## 6. Workflow

### 6.1 Commits and PRs

- **Who does what.** Agents commit, push and open PRs automatically. The human reads them and
  merges to main.
- **PR size.** About 1k changed lines is the floor and about 2.5k is a soft ceiling, with one
  theme per PR. Agent authors should batch their work, because many small PRs slow everyone
  down.
- **The PR body is the main narrative the human reads.** Its sections:
  - What changed and why
  - Evidence on real data
  - Gate output
  - Class closed by
  - Not done, and why
  - Beads closed or filed
  - Cost

  Long investigations go in a linked note.
- **Commits.** A descriptive sentence, then `(bd-xxx)`, then a version where relevant, then
  the agent's co-author trailer.

### 6.2 Review

- **How:** the `review-pr` skill runs in a separate worktree, runs the change on real
  targets, writes adversarial probes, and posts inline comments tagged by severity.
- **What blocks:** a blocker needs a concrete failing input or a real-data result. Style
  never blocks, because the linter owns style.
- **Limits:** one round plus a re-review, then the human decides. After merge, `validate` is
  the final check.

### 6.3 Beads

- **Three kinds:**
  - deferred direction epics (no children)
  - milestone stories and bugs, labelled by track
  - interface beads between tracks, each with an owner and a consumer
- **A bead points to intent; it isn't a spec.**
  - Keep it to about 1,500 characters: the intent and the reason for it.
  - Acceptance names an outcome, not an implementation.
  - Measurements go in PR bodies or notes.
  - Bead notes are a short changelog, not a journal.
- **Grooming** (the `groom` skill, run at each milestone boundary):
  - Create the stories for the new milestone.
  - Close, defer or rewrite stories the milestone doesn't need, with a reason.
  - Close epics whose work is done.
  - Re-verify memories.
  - Limit P1 to the milestone's critical path.
- **Memories.** At most 12, all principles, each carrying `verified: <date>`. Tool gotchas go
  in AGENTS.md or code.
- **Sync** through the Dolt remote. Never commit the export.
- **One instruction source.** A SessionStart hook runs a trimmed `bd prime` of under about
  3k tokens. There are no managed blocks in AGENTS.md or CLAUDE.md.

### 6.4 Validation on real data

- **What it does.** `bun run validate [--target x]` runs every `validate/checks/*` against
  every target and compares the results with `baselines/`. It prints one line per check:
  pass, regress or improve.
- **When it's required.** On any PR touching `core/` or `workflows/`; its table goes in the PR
  body.
- **Baselines** change only in the same PR as the code that moves them.
- **Agentic layer.** Evidence for a prompt or agent change is a run graded against the
  adopter's evaluation set.
- **First milestone.** Every new repo's first milestone is "first result on a real target".

### 6.5 Dependencies between repos

- Repos stay separate. A foundation library serves many applications, so there is no monorepo.
- Internal dependencies ship as release tarballs.
- `mshape bump <dep>` downloads a tarball, verifies its hash, updates the lockfile and runs
  the gate. The hash lives in package.json and the lockfile, never in prose.
- For co-development, use a documented `bun link` override.
- An upstream release smoke-tests its consumers' real workflows.
- Consumer-side workarounds carry a `TODO(bd-xxx)` pointing at the upstream bead.
- The version comes from package.json.

## 7. Decision authority (template; the adopter fills in the blanks)

**Needs the human:**
- **Priorities and milestones.**
- **Spend above `<cap>` per day.** Below the cap, real-data learning is approved
  automatically. Above it, a short **run plan** is worked out with the human before launch:
  the question being answered, the expected cost, the targets, and what result would change
  the plan. In the agentic layer the harness enforces the cap with a spend ledger.
- **Anything that leaves the machine:** disclosure, public releases, public remotes, actions
  on devices, live network targets.
- **Deleting data that can't be regenerated.**
- **A new repo or a new core dependency.**
- **Merging to main.**

**Agents decide without asking:**
- architecture and refactors of any size
- writing, rewriting or deleting any in-repo doc, decision or check
- creating, closing and rewriting beads within the current milestone
- opening PRs
- spending under the cap

When in doubt, act, then explain what you did and why in the PR body.

## 8. Gardening

`mshape garden` prints the budgets; the gate enforces the hard caps. At each milestone
boundary the `garden` and `groom` skills run, and their combined output is a single PR.

| Item | Hard cap | Reviewed at the boundary when |
|---|---|---|
| AGENTS.md | 150 lines | it grew |
| DECISIONS.md | 15 entries × 150 words | an entry is policy-only |
| bd memories | 12 memories, 6 KB | `verified` predates the last boundary |
| Handoff lessons not yet promoted | — | always: promote or delete |
| Escape hatches and ratchets | must not increase | any increase |
| Files over 600 LOC | warn; fail over 1,200 unless allowlisted | — |
| Open stories outside the milestone | — | always |

The sweep also tries to turn each prose rule into a check, and turns review findings that
keep recurring into checks, upstream when they are general.

## 9. Building monkeyshape

monkeyshape is built under its own rules from the first commit. It has its own AGENTS.md,
DECISIONS.md and beads, and it passes its own gate.

1. **v0.1, the gate (built):**
   - `mshape check` with:
     - arch: a config-driven module map, host access, package allowlists and cycles
     - refs
     - budgets
     - coverage
     - ratchets
   - The base tsconfig and biome configs.
   - The first five custom rules: decodeStrict, banned globals, the throw/Error allowlist,
     where `Effect.run*` may appear, and spreading error values.
   - Fixtures for every rule.
2. **v0.2, the template:** `mshape init`, `mshape worktree`, the AGENTS.md, DECISIONS.md and
   PR templates, CI, hooks, and the beads setup.
3. **v0.3, the skills and the remaining rules:** `review-pr`, `groom`, `garden`, `handoff`,
   and the rest of §4.2, including the agentic layer.
4. **Adoption guide:**
   - A new repo runs `mshape init`.
   - An existing repo adopts at a sync point. Parallel work finishes its current PRs, and one
     knowledge-migration PR reshapes the docs, decisions, memories, handoffs and beads.
     Code-level rules land as ratchets, so in-flight work sees no churn.
