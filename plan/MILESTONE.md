# Milestone 3: ready for a real application and a new repo

**Draft for approval, 2026-11-04; revised after the maintainer's review (PR #49).** Beads
are filed only after the maintainer approves. Once tracks start, the plan is frozen, except
that a divergence the maintainer approves is appended under "Amendments" with its date and
reason.

## Why this milestone

monkeyshape is meant for every repo its maintainers start or keep, and so far it has been
used only on itself: a TypeScript CLI package with a `src/` root, one language, no data and
no model calls. Milestone 2 made the loop work between parallel tracks; its retrospective
(the four milestone-2 handoffs) found that agent-to-agent and human-to-agent work now goes
without relaying. The next roadmap goals are both adoption: an existing repo (`36f`) and a
new one born through the loop (`iqf.14`).

To see whether monkeyshape is ready, the boundary ran it, in scratch copies, against two
real cases, and four independent reviews (code quality, process, the existing repo's
history, monkeyshape as a product) read the results without being told what to conclude:

- **An existing private application**: TypeScript on the same stack, about 80k lines, seven
  top-level code directories and no `src/`, months of history with agents, and secondary
  code in other languages (scripts, compiled helpers, fixtures, a vendored tarball).
- **A new repo**: TypeScript orchestration plus C code, large data kept outside the repo, a
  dependency on another repo's release.

What they found, as defects in monkeyshape (each reproduced in scratch):

- **Checks that pass when they should fail.** `arch` with `root: "."` matches no file and
  prints "passed" (`src/core/arch.ts`, the `${root}/` prefix), so a repo without a single
  source root can't be mapped. Default `sources` that match nothing are silent too.
- **False positives on correct code.** About 20 of 32 `decode-strict` findings on the
  application were strict decodes: the rule accepts only an inline options object, not a
  same-file `const`, and fires on branded-string schemas where excess properties mean
  nothing. `arch/host-access` flags `node:crypto`'s `createHash`, a pure operation.
- **A green gate that didn't look.** `isTsSource` gates budgets, coverage, refs, garden and
  arch. A C file calling `gets`, a Python script, a shell script and a 30 MB binary all
  passed `mshape check` in a born repo; garden reported no large files.
- **No home for an adopter's own rules.** The application's most expensive bug class (about
  20 bugs: derived data keyed on too few inputs, an index replaced instead of merged, an
  identity missing a field) was fixed each time by routing every caller through one
  function; one bead closed with "the lesson was written down in an accepted decision
  record and still did not transfer". The class is domain-specific; today `rules` in
  `shape.config.ts` only configures the registry's rules.
- **The adoption path, followed literally:** `bun add` unpinned the adopter's exact
  versions; `--config` outside the repo can't resolve the `effect` peer; synced skills fail
  the adopter's `refs` check (`bun run mshape` isn't a script); `baseline --init` before
  `sync` leaves the gate red; the base biome `noConsole` override hard-codes `src/cli/**`
  and `tools/**`; the hooks exit 127 at every prompt before `mshape` is installed;
  `budgets/claude-md` fights the block `bd setup` appends.
- **A born repo starts red.** `mshape init` from a checkout copies that checkout's skills but
  installs the npm release, so the first gate fails with `skills/sync-due`; a packed tarball
  carries npm's version number with different contents.
- **Repos that depend on repos** have no mechanism, and both cases need one.
- **The loop, from the tracks' retrospectives:**
  - `main` can send but not receive (`msg send main` fails), so a boundary session can ask
    the tracks a question but not get the answer by mail. All four tracks hit it.
  - A reviewer launched in a track's worktree receives that track's mail, because a live
    session inside a worktree gets the notice whether or not it registered; launched from
    the main checkout, a reviewer has no address at all.
  - `liveSessions` prunes as it reads: a probe deleted a real registration (#30).
  - `track list` migrated four live handoffs as a side effect of listing (#32's branch).
  - Long review rounds came from a lifecycle fact defined in one sentence: #39's `done` took
    four rounds, each a case the definition didn't cover (a reused name, a just-made track,
    a partly deferred bead).

It comes now because both adoptions are next, and each defect either blocks them or would be
paid for on every future repo. Each fix has a consumer (principle 8). The measure for every
item below is three questions: does it remove a demonstrated, recurring failure; does it
generalize past the repo that surfaced it; is it the simplest mechanism that holds. An
adopter's own policy stays in that adopter; monkeyshape provides the mechanism to enforce it.
After this milestone the next step is the first real adoption, not another framework
milestone: that adoption decides what monkeyshape needs next.

## Goal, and how we'll know

Goals 1 to 5 are **must-have before adoption**. Goals 6 and 7 are **worth doing if
contained**: a track drops what doesn't fit, and says so.

1. **A green gate means what it says.** Every check reports one of four outcomes: ran and
   passed; nothing applicable; couldn't run; exempt, with a reason. A configured glob or
   module that matches nothing fails, unless it is declared optional. A prerequisite that
   couldn't run fails the gate when it is required, and is a note only when the config
   declares it optional. `mshape check` prints the outcomes, so a pass shows what was
   looked at.
2. **Checks tell the truth on a real layout.** A module map at the repo root or across
   several top-level directories. `decode-strict` resolves same-file options and skips
   schemas with no properties, with aliases and shadowing handled. `host-access` judges an
   operation, not a module (`createHash` is pure, `randomBytes` is not). `noConsole` follows
   the config's declared entry files.
3. **Adopters extend the engine.** An adopter writes a rule in its own repo, against a small
   stable interface, in the same engine as the registry's: same scope, allowances,
   `shape-ignore`, report format and rule-cases test. A rule that is missing, fails to load or
   is misconfigured fails the gate. The pattern documented for a domain bug class: one
   function as the only enforcement point, and a rule that bans going around it, so the rule
   catches every implementation, not the one that was seen.
4. **No file is silently overlooked.** Each tracked file is TypeScript (deep checks, as
   today), or matched by a declared command that `mshape check` runs and reports, or
   structured data parsed with Bun's own parsers (JSON, YAML, TOML), or documentation (refs
   and budgets), or exempt with a reason. Tracked files have a size cap with explicit
   exceptions; a vendored artifact's hash is recorded and checked. No language analysis
   beyond running the adopter's command.
5. **Adoption and birth work as written.** `docs/adopting.md`, followed literally on a real
   mature repo, reaches a green gate with no undocumented step, and sorts the repo's
   knowledge into four kinds: history worth keeping (kept, not loaded), current
   instructions (short, loaded), obsolete or duplicated text (retired), and invariants
   (tests or adopter rules). Nothing is deleted to meet a budget. `init` makes a repo whose
   first gate is green from a checkout, a tarball or npm; hooks degrade to a note before
   `mshape` is installed; a release is reproducible from its tag.
6. **The loop, contained.** Every session has an address (a track, `main`, `review-<n>`),
   and a review started from the main checkout moves to its own; reads never prune; a
   migration is its own command, never a side effect; the `milestone` skill gives each
   lifecycle or workflow fact a plan introduces as a case table, which the owning track
   turns into its test first.
7. **Small additions, contained.** `mshape dep bump` for a dependency on another repo's
   release tarball; and, after a `@effect/tsgo` spike, the two Effect rules below, or
   `tsgo`'s own diagnostics if they cover the same failures.

**Acceptance on real data:**
- **The existing application, at a pinned commit** (a private repo; a scratch clone, run by
  `checks`, `rules` and `adoption`, recorded as one table in each PR: counts and rule ids,
  never its code):
  - production TypeScript files found, typechecked, linted and analyzed by rules;
  - every other tracked file: its declared command and that command's outcome, or its
    exemption, grouped by reason;
  - existing violations baselined, by rule;
  - `arch` finds its real cross-module imports, and fails on a map entry matching nothing;
  - every remaining `decode-strict` and `host-access` finding is a real one, each listed;
  - an adopter rule fails on two different bugs of one class from its history (replayed from
    its git log) and passes on the commits that fixed them;
  - a fresh agent following `docs/adopting.md` reaches a green gate; every step it had to
    improvise is a defect fixed in this milestone.
- **A new repo born from the release**, with C code and a data directory outside the repo:
  its gate is red on a C file that doesn't compile, a tracked 30 MB binary and an unrecorded
  vendored tarball, and says "couldn't run" (red) when the declared compiler is missing;
  green once each is fixed.
- **Two real Claude Code sessions, run by the maintainer:** a review started from one of two
  sessions in the main checkout gets none of the reviewed track's mail and leaves the other
  session's address alone; a track's `msg send main` reaches the main session as a live
  notice.
- **A release is published** (0.4.0), and the README quick start works from npm.

## Non-goals

- **Analysis of languages other than TypeScript,** a language-plugin framework, or schema
  validation of arbitrary config files: the adopter's own command is the check (goal 4).
- **A broad Effect framework** or a second architecture system. Effect belongs where it buys
  an execution guarantee (typed failures, cancellation, resource lifetimes, supervision,
  composition, testability); pure transformations stay plain TypeScript. Improving
  monkeyshape's own Effect use and its Effect enforcement is its own epic (below); this
  milestone takes only the two rules in goal 7.
- **`decode-strict` at trust boundaries:** knowing where a boundary is needs the module map
  to say it (a later `arch.modules` extension); this milestone removes false positives only.
- **Handoff backup through the remote:** no adopter is hurt yet (no cloud or second-machine
  sessions); revisit when one is.
- **Live delivery and hooks for agents other than Claude Code; a default branch other than
  `main`; a host other than GitHub:** no adopter uses them. The README says so.
- **A derived-data helper, or an "absent is not 0" rule:** one consumer; adopter rules
  (goal 3) carry them there first, and show what a general version would need.
- **Paused tracks:** a pause is already expressible. Its beads are deferred out of the
  milestone (dropping their `track:` label), the track is removed, and `bd dep` records what
  the work waits on.
- **A refs exemption for a frozen design document:** the adopter keeps the document as
  history (goal 5) and replaces section citations in code with decision slugs or tests, under
  a baseline.
- **Locks on shared data, a home for sensitive narrative, spend approval per run:** one
  consumer each, kept in that adopter until a second repo needs them.
- **The adoptions themselves:** the existing application adopts in a milestone of its own,
  in its repo; the new repo's first milestone is its own. This milestone makes monkeyshape
  ready and proves it on scratch copies.
- **Capping review rounds:** goal 6's case tables remove a cause of long rounds, not rounds.

## Where we are

| Area | Today |
|---|---|
| A pass | means "no violation found", including when nothing was examined |
| `arch` without `src/` | `root: "."` matches 0 files and passes; with the code moved under `src/`, 14 findings |
| `decode-strict` | 32 findings on the application, about 20 false (options in a `const`, branded strings) |
| `host-access` | 11 findings on the application, 9 of them `createHash` |
| Non-TS files | C, Python, shell and a 30 MB binary: 0 findings in a born repo |
| A tool that can't run | always a note, so a missing compiler would pass |
| Adopter rules | none: `rules` configures registry rules only |
| `docs/adopting.md` | 7 defects when followed literally (above) |
| `init` from a checkout | first gate red: 5 `skills/sync-due` |
| Mail to `main` | `no track main to send to` |
| npm | 0.2.0, published before milestone 2's mailbox merged |

## What changed since milestone 2, and why

- Milestone 2 shipped every story bead (#23 to #48): `mshape sync` and PRIME.md, `track pr`
  and `pr.yml`, the mailbox and live notices, derived `done`, review's Fit section.
- After its retrospective, `4q6` (retiring a track whose name the next milestone reuses) was
  fixed with `track rm --keep-beads` (#43, #46, #48), which `/milestone` step 8 uses (#45, #47).
- Two of its acceptance lines were not met at the boundary: the release (0.2.0 shipped before
  the mailbox) and the maintainer's recorded two-session run (`f4y.22`). Phase 0 closes both.
- "A tool that can't run degrades to a note" (an AGENTS.md gotcha) becomes goal 1's contract:
  a note only for a prerequisite declared optional. `adoption` rewrites the gotcha.
- This plan's first draft was narrowed in review: language handling is the adopter's command,
  not analysis; the Effect rules wait on a `tsgo` spike; handoff backup is deferred; adoption
  keeps history rather than retiring it; acceptance counts coverage, not only passes.

## Phase 0: the milestone-2 boundary (before the tracks start)

Done by the maintainer and the planning agent, in this order:
1. Record `f4y.22`: the boundary's retrospective request went from `main` by `mshape msg` to
   all four tracks, each notified live while idle, each answered without relaying. The
   maintainer confirms and closes it, with milestone 2's epic.
2. Publish 0.3.0 from `main` (the maintainer): milestone 2's template changes reach npm.
3. Remove the four milestone-2 tracks (`/milestone` step 8); none continues.
4. File the epic, the beads below and the Effect epic (deferred, outside this milestone).

## Interfaces the tracks share

Settled before the tracks start. A change goes to the other tracks by `mshape msg` and to the
maintainer.

- **Ownership of files,** so no two tracks edit the same file:
  - `checks`: `src/core/check.ts` and `src/core/report.ts` (the outcome contract),
    `src/core/arch.ts`, `src/core/rules/decodeStrict.ts`, `src/helpers/`, the `arch` and
    `sources` sections of `src/schemas/config.ts`, `config/` (biome and tsconfig bases).
  - `rules`: `src/core/rules/engine.ts`, `registry.ts` and each new rule file, the `rules`
    section of the config schema, and what `src/api/monkeyshape.ts` exports for adopter
    rules.
  - `languages`: `src/core/coverage.ts`, `src/core/budgets.ts`, `src/core/model.ts`'s file
    classification, `src/core/garden.ts`, a new `files` check, and the `coverage`, `budgets`
    and `files` sections of the config schema.
  - `adoption`: `docs/adopting.md`, README, AGENTS.md, `src/adapters/init.ts`,
    `src/core/scaffold.ts`, `template/`, `src/{core,adapters}/sync.ts`, `src/core/hooks.ts`,
    the config loader (`src/adapters/config.ts`), the release script, and `mshape dep`.
  - `loop`: `src/{core,adapters}/mail.ts`, `src/{core,adapters}/notices.ts`,
    `src/adapters/reviews.ts`, `src/{core,adapters}/tracks.ts`, `src/{core,adapters}/trackPr.ts`,
    `src/core/handoff.ts`, `src/core/layout.ts`, and the `track`, `handoff`, `review-pr`,
    `milestone` and `roadmap` skills.
  - Shared tables, additions only: `KINDS` in `src/core/check.ts` (its entries; `checks`
    owns the rest of the file), the command table in `src/cli/main.ts`, the top-level keys of
    `ShapeConfig`, `test/core/ruleCases.test.ts`.
  - A change in another track's file goes to that track as a message or a bead.
- **The outcome contract (owner `checks`, consumers every track).** Each check returns its
  violations plus an outcome: `passed`, `not-applicable`, `unavailable` (with the missing
  prerequisite), or `exempt` (with the reason). `unavailable` fails the gate unless the config
  declares that prerequisite optional. A glob or module matching nothing fails unless declared
  `optional: true`. `mshape check` prints one line per check with its outcome and what it
  examined (for example, files analyzed). This lands in `checks`' first PR; the others build
  on it.
- **Declared commands (owner `languages`, consumer `adoption`'s docs).** A repo declares, in
  `shape.config.ts`, globs and the command that checks them (`{ files, run, optional? }`).
  `mshape check` runs each command with the files' tool on PATH, and reports its outcome
  under the contract; a missing tool is `unavailable`. Coverage fails a tracked file that no
  check accounts for: TypeScript, a declared command, structured data (parsed with Bun's
  JSON, YAML and TOML parsers), documentation, or an exemption with a reason. The template
  declares none. Lands in `languages`' first PR.
- **Tracked files (owner `languages`).** The `files` check: a size cap for tracked files,
  explicit per-path exceptions with a reason, and `.env*` never tracked (the template's
  ignore list gets it too, through `adoption`).
- **Adopter rules (owner `rules`, consumer `adoption`'s docs).** `shape.config.ts` names local
  rule modules. Each exports what a registry rule has and nothing more: an id, a `bugClass`, a
  message, and a function from a parsed file to offsets, over a small exported AST helper
  set, not the parser's internals. Ids are namespaced (`local/<id>`) and appear in
  `mshape rules` and garden. A module that fails to load or export the shape fails the gate.
  Each rule needs must-fail, must-pass and allowed-exception cases in the adopter's tests.
  The engine stays the one owner of scope, allowances and `shape-ignore`. Lands in `rules`'
  first PR.
- **Module map at the root (owner `checks`).** `arch.root` may be `.`, and a module may name
  its directory by a path. Matching follows the outcome contract.
- **Vendored releases (owner `adoption`).** A dependency on another repo is its release
  tarball under `vendor/`, recorded in `shape.config.ts` with its package name and sha256,
  which the `files` check verifies. `mshape dep bump <name> <tarball> --sha256 <digest>` takes
  the digest from the upstream release, refuses a mismatch or a different package name,
  updates `package.json`, the lockfile and the record, and runs the gate. It never fetches.
- **Session addresses (owner `loop`).** A session's address is the checkout it serves. Its
  cases, which `loop` turns into a table test first:

  | Case | Result |
  |---|---|
  | a session starts in a track's worktree | registered at `<track>` |
  | a session starts in the main checkout | registered at `main` |
  | a session in the main checkout runs `mshape review <n>` | moves to `review-<n>`; any other session at `main` is untouched |
  | it runs `mshape review <n>` again, for a new head | stays at `review-<n>` |
  | it runs `mshape review <m>` while at `review-<n>` | moves to `review-<m>`; `review-<n>`'s mail stays for `review-<n>` |
  | `mshape review rm <n>` | that address's registrations are removed; its unread mail is listed first |
  | `/clear` or a restart in a review session | registers at `main` again, until `mshape review <n>` reruns |
  | a second live session registers where one already is | both registered; `register` warns |
  | no session identity (no session id or pid) | no address, and a note; never a guess |
  | which session to move is ambiguous | refuses, naming the sessions |
  | a live session inside a worktree that never registered | gets nothing (no fallback by directory) |
  | a registration whose session ended | pruned by `send`, never by a read |

  `msg send main` and `msg send review-<n>` are valid; `inbox` and `read` work at each
  address; `liveSessions` only reads.
- **Migrations (owner `loop`).** `mshape track migrate` rewrites handoffs to the current
  format and prints what it changed; `track list` only reports a handoff that needs it.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `checks` | goals 1, 2 | The outcome contract and its output (first PR); `arch` at the root and across directories; `decode-strict` false positives (same-file options, property-less schemas, aliases, shadowing); `decodeStrict` helper variants for sync decodes; `host-access` per operation; `noConsole` from declared entry files | On the pinned application clone: the coverage table; `arch` finds its real cross-module imports; each remaining `decode-strict` and `host-access` finding is real, listed in the PR |
| `rules` | goals 3, 7 | The adopter-rule interface and loader (first PR), with `mshape rules`, garden and rule-cases covering adopter rules; the enforcement-point pattern, documented with its example rule; then a `@effect/tsgo` spike: if its diagnostics cover `Effect.promise` on an operation that can reject and an expected decode failure escaping as a defect, adopt them; otherwise write those two rules, each with an allowance for a promise that cannot reject | An adopter rule in the clone fails on two different historical bugs of one class and passes on their fixes; a broken rule module fails the gate; the spike's report, and the rules or diagnostics it chose, each with must-fail and must-pass cases |
| `languages` | goal 4 | Declared commands (first PR); coverage that accounts for every tracked file; structured-data parsing; line budgets and garden over any text source; the `files` check | A born repo is red on a C file that doesn't compile, a tracked 30 MB binary and an unrecorded vendored tarball, and `unavailable` (red) with the compiler missing; green once fixed; the clone's other files appear in the coverage table |
| `adoption` | goals 5, 7 | `docs/adopting.md` rewritten from a literal run on the pinned clone, with the four kinds of knowledge and each defect above; the AGENTS.md gotcha for the outcome contract; `init` green from a checkout, tarball or npm, with versions that say what they contain; hooks before install; a release reproducible from its tag; `mshape dep bump`; the fresh-agent test over an adopted repo | A fresh agent following `docs/adopting.md` on the clone reaches a green gate, improvising nothing; `init` from a checkout is green on its first gate; `dep bump` refuses a wrong digest and moves a right one |
| `loop` | goal 6 | Session addresses (the case table) and `review-pr`'s step that moves the reviewer; `liveSessions` reads only; `mshape track migrate`; case tables for lifecycle facts in the `milestone` skill; splitting `test/adapters/tracks.test.ts` (1172 lines, near the cap) by command | The maintainer's two-session run above; `track list` never rewrites a handoff |

**Order:** each track's first PR lands its interface (the outcome contract, adopter rules,
declared commands); the rest build on them, and nothing else waits. `adoption`'s literal run
happens last, against everyone's merged work, and its findings become beads for whichever
track owns the file. P1 is goals 1 to 5; goals 6 and 7 are P2.

## Proposed beads (filed after approval)

- **checks:** the outcome contract and output; `arch` at the root and across directories;
  `decode-strict` false positives; `decodeStrict` sync variants; `host-access` per
  operation; `noConsole` from declared entry files.
- **rules:** the adopter-rule interface and loader; `mshape rules`, garden and rule-cases
  over adopter rules; the enforcement-point pattern and its example; the `tsgo` spike; the
  two Effect rules or `tsgo`'s diagnostics (P2).
- **languages:** declared commands; coverage over every tracked file; structured-data
  parsing; budgets and garden over any text source; the `files` check.
- **adoption:** `docs/adopting.md` from a literal run, with the four kinds of knowledge;
  the outcome-contract gotcha; `init` green from any source; hooks before install; a
  reproducible release; `mshape dep bump` (P2); the fresh-agent test over an adopted repo;
  `.env*` in the template.
- **loop (P2):** session addresses and `review-pr`'s move; reads never prune; `track migrate`;
  case tables in `milestone`; the `tracks.test.ts` split.
- **milestone:** the acceptance run, the 0.4.0 release, and the quick start from npm.
- **Outside this milestone, deferred:** an Effect epic with two workstreams that inform each
  other: monkeyshape's own Effect use (subprocess cancellation, resource cleanup, typed
  failures, interruption and failure-injection tests), and Effect enforcement (rule
  corrections, type-aware diagnostics, execution boundaries, checks for recurring resource
  and concurrency mistakes). A real bug fixed in one becomes a regression test or rule in
  the other.

## Decision points

- **If adopter rules can't share the engine** without exporting the parser's internals,
  `rules` reports the smallest surface that works before building on it; the maintainer
  decides what becomes public.
- **The `tsgo` spike** reports what its diagnostics cover before either Effect rule is
  written; adopting `tsgo` is a new dev dependency for adopters, so it is the maintainer's.
- **If a declared command needs a toolchain CI doesn't have,** `languages` says so: the
  template's CI installs only Bun, and whether it grows a toolchain list is the maintainer's.
- **If the outcome contract turns a currently green adopter red** (an optional tool now
  required), `checks` lists which prerequisites default to optional, and the maintainer
  approves the defaults.

## Deferred, with reasons

- The Effect epic beyond goal 7: its own priority, after the first adoption shows which
  failures recur.
- Handoff backup through the remote; Cursor and Codex; another default branch or host:
  no adopter needs them yet (Non-goals).
- The derived-data helper and an "absent is not 0" rule: one consumer; revisit after its
  adopter rules exist.
- Locks on shared data, a sensitive-narrative directory, spend approval per run: one
  consumer each.
- `mshape validate` (`97o`) and the agentic layer (`v56`): the first adoption runs without
  them; they come when a repo's real-data runs are its bottleneck.
- A default timeout for integration tests: one occurrence (#36), fixed in place.
- Remaining starter rules (`hh2`), policy bundles (`8h4`), gate hardening (`nm9`): unchanged,
  no consumer yet.

## Spend

None: no model calls in this milestone's code.

## Amendments

None yet.
