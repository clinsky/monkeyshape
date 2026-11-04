# Milestone 3: ready for a real application and a new repo

**Draft for approval, 2026-11-04.** Beads are filed only after the maintainer approves. Once
tracks start, the plan is frozen, except that a divergence the maintainer approves is
appended under "Amendments" with its date and reason.

## Why this milestone

monkeyshape is meant for every repo its maintainers start or keep, and so far it has been
used only on itself: a TypeScript CLI package with a `src/` root, one language, no data and
no model calls. Milestone 2 made the loop work between parallel tracks; the boundary
retrospective (the four milestone-2 handoffs) found that the agent-to-agent and
human-to-agent loop now works without relaying. The next roadmap goals are both adoption:
an existing repo (`36f`) and a new one born through the loop (`iqf.14`).

To see whether monkeyshape is ready for them, the boundary ran it against two real cases, in
scratch copies, and had four independent reviews read the results without being told what to
conclude: one on code quality, one on process, one on an existing repo's history, and one on
monkeyshape as a product.

- **An existing private application**: TypeScript on the same stack, about 80k lines, seven
  top-level code directories and no `src/`, months of history with agents.
- **A new repo**: TypeScript orchestration plus C code compiled for other architectures,
  large binary data kept outside the repo, a dependency on another repo's schemas.

What they found, as defects in monkeyshape (each reproduced in scratch):

- **Checks that pass when they should fail.** `arch` with `root: "."` matches no file and
  prints "passed", so a repo without a single source root can't be mapped at all
  (`src/core/arch.ts`, the `${root}/` prefix). Default `sources` that match nothing give no
  note, so the rules are silent too.
- **False positives on correct code.** 20 of 32 `decode-strict` findings on the
  application were strict decodes: the rule accepts only an inline options object, not a
  same-file `const`, and fires on branded-string schemas where excess properties mean
  nothing. `arch/host-access` flags `node:crypto` hashing, while `Bun.hash` is allowed.
- **TypeScript is the only thing the gate sees.** `isTsSource` gates budgets, coverage, refs,
  garden and arch. A C file calling `gets`, a Python script, a shell script and a 30 MB
  binary all passed `mshape check` in a born repo; garden reported no large files.
- **Nothing guards what must never be tracked.** No size or binary cap on tracked files, no
  "never tracked" paths, `.env*` not in the template's `.gitignore`, and `refs.forbidden`
  reads only docs and comments, not code, string literals or file names.
- **An adopter can't add a rule.** The existing repo's most expensive bug class (about 20
  bugs: derived data keyed on too few inputs, indexes replaced instead of merged, identities
  missing a field) was fixed each time by one function; one of its beads closed with "the
  lesson was written down in an accepted decision record and still did not transfer". The
  class is domain-specific, so principle 3 needs a home for adopter rules, and today
  `rules` in `shape.config.ts` only configures the registry's rules.
- **The adoption path itself.** Following `docs/adopting.md` literally: `bun add` unpinned
  the adopter's exact versions; `--config` outside the repo can't resolve `monkeyshape`'s
  peer; synced skills fail the adopter's `refs` check (`bun run mshape` isn't a script);
  `baseline --init` before `sync` leaves the gate red; the base biome `noConsole` override
  hard-codes `src/cli/**` and `tools/**`; the hooks exit 127 at every prompt before
  `mshape` is installed; `budgets/claude-md` fights the block `bd setup` appends.
- **A born repo starts red.** `mshape init` from a checkout copies that checkout's skills but
  installs the npm release, so the first gate fails with `skills/sync-due`; a packed tarball
  carries the same version number as npm with different contents.
- **Repos that depend on repos** have no mechanism (roadmap, "Dependencies between repos").
- **The loop, from the four tracks' retrospectives:**
  - `main` can send but not receive: `msg send main` fails, so a boundary session can ask
    the tracks a question but not get the answer by mail. All four tracks hit it.
  - A reviewer launched in a track's worktree receives that track's mail, because a live
    session inside a worktree gets the notice registered or not; launching reviews from the
    main checkout avoids it but leaves the reviewer with no address.
  - `liveSessions` prunes as it reads: a probe deleted a real registration (#30).
  - `track list` migrated four live handoffs as a side effect of listing (#32's branch).
  - Handoffs live only under `.git/`: nothing pushes them, so a fresh clone or a cloud
    session can't see them.
  - Long review rounds came from definitions with uncovered cases: #39's `done` took four
    rounds, each a lifecycle case the plan's one-sentence definition didn't cover (a reused
    name, a just-made track, a partly deferred bead). `4q6` was the same fact from another
    side (fixed in #43, #46, #48).

It comes now because both adoptions are the next goals, and each of these defects either
blocks them or would be paid for on every future repo. Building them first, against real
cases, is what principle 8 asks: a consumer exists for each.

## Goal, and how we'll know

1. **Checks tell the truth on a real layout.** No silent pass and no false positive on
   correct code: a module map at the repo root or across several top-level directories; an
   error when a declared module or a `sources` glob matches nothing; `decode-strict` that
   resolves same-file options and skips schemas with no properties; pure `node:` modules
   (hashing, compression) are not host access.
2. **Adopters extend the engine.** An adopter writes a rule in its own repo, in the same
   engine as the registry's: same scope, allowances, `shape-ignore` comments, report format
   and rule-cases test. Two new core rules for Effect bug classes the reviews found:
   `Effect.promise` (a rejection becomes a defect, not a typed error) and a sync decode or
   `JSON.parse` inside `Effect.gen` outside `Effect.try`.
3. **The gate covers every tracked file.** Every tracked file is TypeScript (held to `tsc`
   and biome as today), or matched by a declared language whose gate step compiles or lints
   it, or exempt with a reason. Line budgets count any text source. Tracked files have a size
   cap and a binary rule; declared paths are never tracked; forbidden patterns are matched
   over all tracked text. The template ignores `.env*`.
4. **Adoption works as written.** `docs/adopting.md` followed literally on a real existing
   repo reaches a green gate with no undocumented step; `init` makes a repo whose first gate
   is green from a checkout, a tarball or npm; hooks degrade to a note before `mshape` is
   installed; a repo depends on another repo's release tarball and bumps it with one
   command that verifies its hash and runs the gate.
5. **Every session has an address.** A track's worktree, the main checkout and a review
   worktree are each a mailbox. A review session started from the main checkout moves to
   its review's address. Reads never prune.
6. **Handoffs and migrations are safe.** Handoffs are backed up through the remote and
   restored in a fresh clone; a format migration is its own command, never a side effect.
7. **Plans define derived facts by their cases.** The `milestone` skill writes every derived
   fact a plan introduces as a table of lifecycle cases, which the owning track turns into a
   table-driven test before the code.

**Acceptance on real data:**
- **The existing application** (a private repo; a scratch clone at its `main`, run by the
  `checks`, `rules` and `adoption` tracks and recorded in their PRs as counts and rule ids,
  never its code):
  - `arch` with its real module map finds its real cross-module imports, and fails on a map
    entry that matches nothing.
  - Every `decode-strict` and `host-access` finding on it is a real one, each reviewed and
    listed in the PR.
  - An adopter rule written in its `shape.config.ts` fails on a bug from its history,
    replayed from its git log (an index replaced instead of merged), and passes on the
    commit that fixed it.
  - `docs/adopting.md`, followed literally by a fresh agent, reaches a green gate; every
    step it had to improvise is a defect fixed in this milestone.
- **A new repo born from the release** with C code and a data directory outside the repo:
  its gate goes red on a C file that doesn't compile, a tracked 30 MB binary, a tracked
  `.env` and a forbidden pattern in a string literal, and green once each is fixed. It
  depends on another repo's release tarball, and `mshape dep bump` moves it.
- **Two real Claude Code sessions, run by the maintainer:** a review started from the main
  checkout gets none of the reviewed track's mail; a track's `msg send main` reaches the
  main session as a live notice; a handoff is restored in a fresh clone.
- **A release is published** (0.4.0), and the README quick start works from npm.

## Non-goals

- **Live delivery and hooks for agents other than Claude Code** (Cursor, Codex): no adopter
  uses them now.
- **A configurable default branch, or a host other than GitHub:** every adopter now uses
  `main` and GitHub. The README says so.
- **A helper for derived data** (a key over the inputs actually read; absent means refuse;
  merge, not replace): one consumer, and its first form is an adopter rule (goal 2), which
  shows what a general helper would need.
- **An "absent is not 0" rule:** a rule can't yet tell decoded external data from any other
  number; the adopter-rule mechanism covers a repo that can.
- **Paused tracks:** a pause is already expressible. The work's beads are deferred out of
  the milestone (dropping their `track:` label), the track is removed, and `bd dep` records
  what it waits on.
- **A "frozen design doc" exemption in refs:** a long design cited by section is the decay
  principle 5 describes; an adopter retires it to `notes/` and burns citations down with
  `baseline`.
- **Locks on shared data, a gitignored home for sensitive narrative, spend approval per
  run:** one consumer each, kept in that adopter's AGENTS.md until a second repo needs them.
- **The adoption itself.** Adopting the existing application is its own milestone, run in
  that repo with its own `/roadmap` and `/milestone`; birthing the new repo is its first
  milestone. This milestone makes monkeyshape ready and proves it on scratch copies.
- **Reworking review:** rounds stay uncapped. Goal 7 removes a cause of long rounds, not the
  rounds.

## Where we are

| Area | Today |
|---|---|
| `arch` without `src/` | `root: "."` matches 0 files and passes; on the application's code moved under `src/`, 14 findings |
| `decode-strict` | 32 findings on the application, about 20 false (options in a `const`, branded strings) |
| `host-access` | 11 findings on the application, 9 of them `node:crypto` hashing |
| Non-TS files | C, Python, shell and a 30 MB binary: 0 findings in a born repo |
| Adopter rules | none: `rules` configures registry rules only |
| `docs/adopting.md` | 7 defects followed literally (listed above) |
| `init` from a checkout | first gate red: 5 `skills/sync-due` |
| Mail to `main` | `no track main to send to` |
| Handoff backup | none; lives in `.git/monkeyshape/handoffs` only |
| npm | 0.2.0, published before milestone 2's mailbox merged |

## What changed since milestone 2, and why

- Milestone 2 shipped every story bead (#23 to #48): `mshape sync` and PRIME.md, `track pr`
  and `pr.yml`, the mailbox and live notices, derived `done`, review's Fit section.
- After the boundary's retrospective, `4q6` (retiring a track whose name the next milestone
  reuses) was fixed: `track rm --keep-beads` (#43, #46, #48), and `/milestone` step 8 uses
  it (#45, #47).
- Two of milestone 2's acceptance lines were not met at the boundary: the release (0.2.0
  shipped before the mailbox) and the maintainer's recorded two-session run (`f4y.22`). Both
  close in Phase 0.
- This plan uses five tracks: the work falls into five sets of disjoint files, and the
  loop's share was twice any other's until split into `adoption` and `loop`.

## Phase 0: the milestone-2 boundary (before the tracks start)

Done by the maintainer and the planning agent, in this order:
1. Record `f4y.22`: the boundary's retrospective request went from `main` by `mshape msg`
   to all four tracks, each notified live while idle, each answered without relaying.
   The maintainer confirms and closes it, with milestone 2's epic.
2. Publish 0.3.0 from `main` (the maintainer): milestone 2's template changes reach npm.
3. Remove the four milestone-2 tracks (`/milestone` step 8); none continues.
4. File the epic and the beads below.

## Interfaces the tracks share

Settled before the tracks start. A change goes to the other tracks by `mshape msg` and to the
maintainer.

- **Ownership of files,** so no two tracks edit the same file:
  - `checks`: `src/core/arch.ts`, `src/core/rules/decodeStrict.ts`, `src/helpers/`, the
    `arch` and `sources` sections of `src/schemas/config.ts`, `config/` (biome and
    tsconfig bases).
  - `rules`: `src/core/rules/engine.ts`, `registry.ts` and every new rule file, the `rules`
    section of the config schema, and how `src/api/monkeyshape.ts` exports what an adopter
    rule needs.
  - `languages`: `src/core/coverage.ts`, `src/core/budgets.ts`, `src/core/model.ts`'s file
    classification, `src/core/garden.ts`, a new `files` check, the `coverage`, `budgets`
    and `files` sections of the config schema, and `refs.forbidden`'s reach (`refs.ts`'s
    forbidden matching only).
  - `adoption`: `docs/adopting.md`, README, `src/adapters/init.ts`, `src/core/scaffold.ts`,
    `template/`, `src/adapters/sync.ts` and `src/core/sync.ts`, `src/core/hooks.ts`, the
    config loader (`src/adapters/config.ts`), and a new `mshape dep` command.
  - `loop`: `src/{core,adapters}/mail.ts`, `src/{core,adapters}/notices.ts`,
    `src/adapters/reviews.ts`, `src/{core,adapters}/tracks.ts`, `src/core/handoff.ts`,
    `src/core/layout.ts`, and the `track`, `handoff`, `review-pr`, `milestone` and
    `roadmap` skills.
  - Shared tables, additions only: `KINDS` in `src/core/check.ts`, the command table in
    `src/cli/main.ts`, the top-level keys of `ShapeConfig`, `test/core/ruleCases.test.ts`.
    Each track adds its own entries and edits no one else's.
  - A change in another track's file goes to that track as a message or a bead.
- **Language coverage (owner `languages`, consumers `adoption` and the template).** A
  repo declares its other languages in `shape.config.ts`: a glob and the package script the
  gate runs for it. The `coverage` check fails a tracked file that is neither TypeScript nor
  matched, nor exempt with a reason, and a declared script the gate doesn't run. The
  template declares none; `adoption` documents it.
- **Tracked files (owner `languages`).** One new check, `files`: a size cap and a binary
  rule for tracked files, with per-path allowances that carry a reason, and `neverTracked`
  globs (the template ships `.env*`). `refs.forbidden` is matched over every tracked text
  file, not only docs and comments, under its existing key.
- **Adopter rules (owner `rules`, consumer `adoption`'s docs).** `shape.config.ts` names
  local rule modules; each exports the same shape a registry rule has (id, `bugClass`,
  message, scope, a function that reports offsets). Their ids are namespaced
  (`local/<id>`), they appear in `mshape rules` and garden, and the rule-cases test requires
  a must-fail and a must-pass case for each, in the adopter's own tests. The engine stays
  the one owner of scope, allowances and `shape-ignore`.
- **Module map at the root (owner `checks`).** `arch.root` may be `.`, and a module may
  name its directory by a path; an error, not a pass, when a declared module matches no
  file. `sources` that match nothing is a note naming the glob.
- **Repo dependencies (owner `adoption`).** A dependency on another repo is its release
  tarball under `vendor/`, recorded with its sha256. `mshape dep bump <name> <tarball>`
  verifies the hash, updates `package.json` and the lockfile, and runs the gate; it never
  fetches over the network by itself.
- **Session addresses (owner `loop`).** A session's address is the checkout it serves. This
  is a derived fact, so here are its cases, which `loop` turns into its table test first:

  | Case | Address | Gets mail for |
  |---|---|---|
  | session starts in a track's worktree | `<track>` | that track |
  | session starts in the main checkout | `main` | `main` |
  | a session in the main checkout runs `mshape review <n>` | moves to `review-<n>` | `review-<n>` only |
  | `mshape review <n>` again, for a new head | stays `review-<n>` | `review-<n>` |
  | `mshape review rm <n>` | registration removed | nothing |
  | `/clear` or a restart in a review session | `main` again, until `mshape review <n>` reruns | as its address |
  | a second live session registers at an address that has one | both; `register` warns | that address |
  | an unregistered live session inside a worktree | none | nothing (no fallback by directory) |
  | a registration whose session ended | pruned at send, never at read | nothing |

  `msg send main` and `msg send review-<n>` are valid; `inbox` and `read` work at each
  address. `liveSessions` only reads; pruning is its own function, called by `send`.
- **Handoff backup (owner `loop`).** Handoffs are mirrored to a ref on the remote
  (`refs/monkeyshape/handoffs`), pushed by `track pr` and by the `handoff` skill;
  `track new <name>` in a clone without the handoff restores it from the ref. When local and
  remote differ in both directions, nothing is overwritten: it refuses and names both.
- **Migrations (owner `loop`).** `mshape track migrate` rewrites handoffs to the current
  format and prints what it changed; `track list` only reports a handoff that needs it.
- **What a fresh agent loads** (owner `adoption`, from milestone 2): the fresh-agent test
  also runs in a repo made by following `docs/adopting.md`, not only one born by `init`.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `checks` | goal 1 | `arch` at the root and over several directories, and an error on a module or `sources` glob matching nothing; `decode-strict` resolving same-file options and skipping property-less schemas; `decodeStrict` helper variants for sync and stream decodes; pure `node:` specifiers in `host-access`, and its missed `await import("node:…")`; the biome base's `noConsole` override for entry files declared in config rather than fixed paths | On the existing application's scratch clone: `arch` finds its real cross-module imports; every `decode-strict` and `host-access` finding is real, each listed in the PR |
| `rules` | goal 2 | Adopter rules in the engine (the interface above), with `mshape rules`, garden and the rule-cases test covering them; the core rules for `Effect.promise` and for a sync decode or `JSON.parse` inside `Effect.gen` | An adopter rule in the application's scratch clone fails on a bug replayed from its history and passes on its fix; each new core rule has its must-fail and must-pass cases |
| `languages` | goal 3 | Declared languages and their gate steps in `coverage`; line budgets and garden for any text source; the `files` check (size cap, binary rule, `neverTracked`); `refs.forbidden` over all tracked text; `.env*` in the template's ignore list (sent to `adoption`, who owns `template/`) | A born repo's gate is red on a C file that doesn't compile, a tracked 30 MB binary, a tracked `.env` and a forbidden string literal, and green once each is fixed |
| `adoption` | goals 4, 2 (its docs), 3 (its docs) | `docs/adopting.md` rewritten from a literal run on the application's scratch clone: pinned installs, `sync` before `baseline`, the `mshape` script, `--config` outside the repo, `CLAUDE.md` with bd's block, adopter rules and declared languages; `init` green from a checkout, a tarball or npm, with versions that say what they contain; hooks that degrade to a note before `mshape` is installed; `mshape dep bump`; the fresh-agent test over an adopted repo | A fresh agent following `docs/adopting.md` on the clone reaches a green gate; a born repo depends on a tarball and `dep bump` moves it; `init` from a checkout is green on its first gate |
| `loop` | goals 5, 6, 7 | Session addresses (the case table above) and `review-pr`'s step to move the reviewer; `liveSessions` reads only; the warning for two sessions at one address; handoff backup and restore; `mshape track migrate`; the `milestone` skill's case tables for derived facts; splitting `test/adapters/tracks.test.ts` (1172 lines, near the cap) by command | The maintainer's two-session run above; a handoff restored in a fresh clone; `track list` never rewrites a handoff |

**Order:** nothing waits on another track at the start. `rules` lands the adopter-rule
interface in its first PR, since `adoption`'s docs describe it. `languages` lands the
`coverage` declaration format first, for the same reason. `adoption`'s literal run happens
last, against everyone's merged work, and its findings become beads for whichever track
owns the file.

## Proposed beads (filed after approval)

- **checks:** `arch` at the root and over several directories, with errors on empty matches;
  `decode-strict` false positives; `decodeStrict` sync and stream variants; pure `node:`
  modules and dynamic imports in `host-access`; `noConsole` for declared entry files.
- **rules:** the adopter-rule interface and loader; `mshape rules`, garden and rule-cases
  over adopter rules; the `Effect.promise` rule; the sync-decode-in-`Effect.gen` rule.
- **languages:** declared languages in `coverage`; budgets and garden for any text source;
  the `files` check; `refs.forbidden` over tracked text.
- **adoption:** `docs/adopting.md` from a literal run, with the seven defects; `init` green
  from a checkout, tarball or npm; hooks before install; `mshape dep bump`; the fresh-agent
  test over an adopted repo; `.env*` in the template.
- **loop:** session addresses and `review-pr`'s move; reads never prune; the two-session
  warning; handoff backup and restore; `mshape track migrate`; case tables in `milestone`;
  the `tracks.test.ts` split.
- **milestone:** the acceptance run, the 0.4.0 release, and the quick start from npm.

## Decision points

- **If adopter rules can't share the engine** without exporting its internals as a public
  API, `rules` reports the smallest surface that works before building on it; the maintainer
  decides what becomes public.
- **If a declared language's gate step needs a toolchain CI doesn't have**, `languages`
  says so: the template's CI installs only Bun, and whether it grows a toolchain list is
  the maintainer's call.
- **The handoff ref and private remotes:** pushing a ref is outward-facing. `loop` confirms
  with the maintainer before `track pr` starts pushing it in this public repo.

## Deferred, with reasons

- Cursor and Codex, a configurable default branch, other hosts: no adopter needs them (see
  Non-goals).
- The derived-data helper and an "absent is not 0" rule: one consumer; revisit after its
  adopter rules exist.
- Locks on shared data, a sensitive-narrative directory, spend approval per run: one consumer
  each.
- `mshape validate` (`97o`) and the agentic layer (`v56`): the first adoption runs without
  them; they come when a repo's real-data runs are its bottleneck.
- A default timeout for integration tests: one occurrence (#36), fixed in place.
- Remaining starter rules (`hh2`) beyond the two in goal 2, policy bundles (`8h4`), gate
  hardening (`nm9`): unchanged, no consumer yet.

## Spend

None: no model calls in this milestone's code.

## Amendments

None yet.
