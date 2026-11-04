# Milestone 3: ready for a real application and a new repo

**Draft for approval, 2026-11-04; revised after the maintainer's review and the four
milestone-2 tracks' reviews (PR #49).** Beads are filed only after the maintainer approves.
Once tracks start, the plan is frozen, except that a divergence the maintainer approves is
appended under "Amendments" with its date and reason.

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
  top-level code directories and no `src/`, months of history with agents, and real
  secondary code in other languages (scripts, compiled helpers, fixtures, a vendored
  tarball).
- **A new repo**, not yet started: TypeScript orchestration plus C code to come, large data
  kept outside the repo, a dependency on the application's release.

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
  `budgets/claude-md` fights the block `bd setup` appends; `mshape sync` overwrites an
  adopter's own PR template and PRIME.md whenever they differ from the shipped copies
  (`src/core/sync.ts`).
- **A born repo starts red.** `mshape init` from a checkout copies that checkout's skills but
  installs the npm release, so the first gate fails with `skills/sync-due`; a packed tarball
  carries npm's version number with different contents.
- **Repos that depend on repos** have no mechanism, and both cases need one.
- **The loop, from the tracks' retrospectives:**
  - `main` can send but not receive (`msg send main` fails), so a boundary session can ask
    the tracks a question but not get the answer by mail. All four tracks hit it.
  - A reviewer started in a track's worktree gets that track's mail: its SessionStart hook
    registers it at the track (`msg register` uses `track current`), and the inbox hooks
    print mail by directory (`src/core/hooks.ts`). Started from the main checkout, a reviewer
    has no address at all.
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

**The cut line.** This milestone must make monkeyshape safe and useful to adopt in a mature
Bun, TypeScript, Effect and beads repo: no silent passes, no excessive false positives, no
destructive `init` or `sync`, and a place for the adopter's own rules. Goals 1 to 6 are
that (P1). Goal 7 is **worth doing if contained** (P2): a track drops what doesn't fit, and
says so. A feature being useful is not a reason to make it a prerequisite for adoption: no
new must-have scope is added during implementation unless a real acceptance run shows the
need, and the session system and the adopter-rule API grow no further than the cases this
plan names and the first consumer needs.

1. **A green gate means what it says.** Every check reports an outcome (the contract and its
   cases are under Interfaces), and `mshape check` prints one line per check with its
   outcome and what it examined. A configured glob or module that matches nothing fails
   unless declared optional; a required prerequisite that couldn't run fails. Every tracked
   TypeScript file is in the rules' scope, or is a test or a declaration file, or is exempt
   with a reason: a repo with TypeScript source whose rules analyzed none of it fails, and
   `not-applicable` means there is no TypeScript source, not that discovery missed it. This
   is separate from typecheck and lint coverage: a file can be typechecked and linted and
   still be outside the rules.
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
4. **No source file is silently overlooked.** Executable source is TypeScript (deep checks,
   as today) or covered by a declared command that `mshape check` runs and reports, or
   exempt with a reason; an uncovered one fails. Everything else is repository metadata,
   held only to a size cap with explicit exceptions; structured data is parsed with Bun's
   own parsers. A vendored artifact's package and hash are recorded and checked. No analysis
   of other languages.
5. **Adoption and birth work as written.** `docs/adopting.md`, followed literally on a real
   mature repo, reaches a green gate with no undocumented step, and sorts the repo's
   knowledge into four kinds: history worth keeping (kept, not loaded), current
   instructions (short, loaded), obsolete or duplicated text (retired), and invariants
   (tests or adopter rules). Nothing is deleted to meet a budget, and `sync` never
   overwrites a file the adopter wrote without a deliberate step. `init` makes a repo whose
   first gate is green from a checkout, a tarball or npm; hooks degrade to a note before
   `mshape` is installed; a release is reproducible from its tag.
6. **Every session has an address.** A track's worktree, the main checkout and a review are
   each a mailbox: `msg send main` works, and a review started from the main checkout moves
   to its own address. Mail follows the address, never the directory, while `track rm`
   still refuses with any session running in the worktree.
7. **The rest of the loop, and repo dependencies, contained.** Reads never prune; a
   migration is its own command, never a side effect; the `milestone` skill gives each
   lifecycle or workflow fact a plan introduces as a case table, which the owning track
   turns into its test first; `mshape dep bump` updates a dependency on another repo's
   release tarball. Its acceptance lines below are conditional on its delivery.

**Acceptance on real data:**
- **The existing application, at a pinned commit** (a private repo; a scratch clone, run by
  `checks`, `rules`, `languages` and `adoption`, recorded as one table in each PR: counts
  and rule ids, never its code):
  - production TypeScript files found, typechecked, linted and analyzed by rules;
  - its real secondary code: each declared command, the files it covers, its outcome, and
    `unavailable` (red) with that command's toolchain missing; a compile error replayed
    from its history (or reintroduced, if its history has none) turns it red;
  - files exempted, grouped by reason; existing violations baselined, by rule;
  - `arch` finds its real cross-module imports, and fails on a map entry matching nothing;
  - every remaining `decode-strict` and `host-access` finding is a real one, each listed;
  - an adopter rule fails on two different bugs of one class from its history (replayed from
    its git log) and passes on the commits that fixed them;
  - a fresh agent following `docs/adopting.md` reaches a green gate without an undocumented
    command, a manual repair or a change to monkeyshape; each such step is a defect fixed
    in this milestone. Application-specific choices the guide asks it to make are not.
- **This repo** stays green under goals 1 and 4 with no declared command and one reasoned
  exemption (`template/`'s TypeScript, which is scaffold data); bd's hooks, `bun.lock`,
  `LICENSE`, git's own files and `.gitkeep` need no configuration. An undeclared Python
  script turns it red, and so does an executable script under `.github/scripts/`.
- **A new repo born from the release**, through npm and through `init --from` a tarball:
  green on its first gate, its `files` check included; its real data directory linked in
  from outside the repo through `sharedPaths`, never tracked; and, if `dep bump` (goal 7) is
  delivered, a dependency on the application's release tarball that it refuses with a wrong
  digest and moves with the right one. Deliberately broken files (a C file that doesn't compile, a 30 MB binary,
  an unrecorded tarball) are the tests' fixtures, not the acceptance.
- **Two real Claude Code sessions, run by the maintainer:** a review started from one of two
  sessions in the main checkout gets none of the reviewed track's mail and leaves the other
  session's address alone; a track's `msg send main` reaches the main session as a live
  notice; `track rm` refuses while an unregistered session runs in that track's worktree.
- **A release is published** (0.4.0), and the README quick start works from npm.

**Closing:** `adoption`'s literal run comes last. A P1 defect it finds is fixed before the
milestone closes, by the track that owns the file (restarted if it has finished); a P2
limitation is deferred with a reason and the maintainer's yes. The run catches regressions
against this plan; it is not a source of new capabilities.

## Non-goals

- **Analysis of languages other than TypeScript,** a language-plugin framework, a
  configurable file taxonomy, or schema validation of arbitrary config files: the adopter's
  own command is the check (goal 4).
- **Effect enforcement and monkeyshape's own Effect use:** no Effect failure was reproduced in
  either real case, so it is not on the path to adoption. Its direction is in
  `docs/roadmap.md` and its work in a deferred epic.
- **`decode-strict` at trust boundaries:** knowing where a boundary is needs the module map
  to say it; this milestone removes false positives only.
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
  ready and proves it on a scratch clone and a born repo.
- **Capping review rounds:** goal 7's case tables remove a cause of long rounds, not rounds.

## Where we are

| Area | Today |
|---|---|
| A pass | means "no violation found", including when nothing was examined |
| TypeScript outside `src/` | with default `sources`, the rules analyze none of it and pass |
| `arch` without `src/` | `root: "."` matches 0 files and passes; with the code moved under `src/`, 14 findings |
| `decode-strict` | 32 findings on the application, about 20 false (options in a `const`, branded strings) |
| `host-access` | 11 findings on the application, 9 of them `createHash` |
| Non-TS files | C, Python, shell and a 30 MB binary: 0 findings in a born repo |
| A tool that can't run | always a note, so a missing compiler would pass |
| Adopter rules | none: `rules` configures registry rules only |
| `docs/adopting.md` | 8 defects when followed literally (above) |
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
  a note only for a prerequisite that is optional. `adoption` rewrites the gotcha.
- Narrowed in review: language handling is the adopter's command, not analysis, and only
  executable source must be covered; Effect moved out entirely; handoff backup deferred;
  adoption keeps history rather than retiring it; acceptance counts coverage and uses real
  code; the outcome contract got its own case table; addresses became must-have; TypeScript
  outside the rules' scope fails; git's own files are exempt by name, not `.git*`; an
  explicit cut line.

## Phase 0: the milestone-2 boundary (before the tracks start)

Done by the maintainer and the planning agent, in this order:
1. Record `f4y.22`: the boundary's retrospective request went from `main` by `mshape msg` to
   all four tracks, each notified live while idle, each answered without relaying. The
   maintainer confirms and closes it, with milestone 2's epic.
2. Publish 0.3.0 from `main` (the maintainer): milestone 2's template changes reach npm.
3. Remove the four milestone-2 tracks (`/milestone` step 8); none continues.
4. File the epic and the beads below, and the deferred Effect epic the roadmap points to.

## Interfaces the tracks share

Settled before the tracks start. A change goes to the other tracks by `mshape msg` and to the
maintainer.

- **Ownership of files,** so no two tracks edit the same file:
  - `checks`: `src/core/check.ts` and `src/core/report.ts` (the outcome contract),
    `src/core/arch.ts`, `src/core/rules/decodeStrict.ts`, `src/helpers/`, the `arch` and
    `sources` sections of `src/schemas/config.ts`, `config/` (biome and tsconfig bases), and
    **any file not listed here**: others send it changes.
  - `rules`: `src/core/rules/engine.ts`, `registry.ts` and their rule files, the `rules`
    section of the config schema, and what `src/api/monkeyshape.ts` exports for adopter
    rules.
  - `languages`: `src/core/coverage.ts`, `src/core/budgets.ts`, `src/core/model.ts`'s file
    classification, `src/core/garden.ts`, `src/core/refs.ts`, a new `files` check, and the
    `coverage`, `budgets`, `refs` and `files` sections of the config schema.
  - `adoption`: `docs/adopting.md`, README, AGENTS.md, `src/adapters/init.ts`,
    `src/core/scaffold.ts`, `template/`, `src/{core,adapters}/sync.ts`,
    `src/{core,adapters}/skills.ts`, `src/core/conventions.ts`, `src/core/hooks.ts`, the
    config loader (`src/adapters/config.ts`), the release script, and `mshape dep`.
  - `loop`: `src/{core,adapters}/mail.ts`, `src/{core,adapters}/notices.ts`,
    `src/adapters/reviews.ts`, `src/{core,adapters}/tracks.ts`, `src/{core,adapters}/trackPr.ts`,
    `src/core/handoff.ts`, `src/core/layout.ts`, `src/core/beads.ts`, and the `track`,
    `handoff`, `review-pr`, `milestone` and `roadmap` skills.
  - Shared tables, additions only: `KINDS` in `src/core/check.ts`, the command table in
    `src/cli/main.ts`, the top-level keys of `ShapeConfig`, the hook list in
    `src/core/hooks.ts` (for `loop`'s inbox hook), `test/core/ruleCases.test.ts`.
  - A change in another track's file goes to that track as a message or a bead.
- **The outcome contract (owner `checks`, consumers every track).** Each check returns its
  violations and one outcome: `passed`, `failed`, `not-applicable`, `unavailable` (naming the
  missing prerequisite) or `exempt` (with the reason). A prerequisite is required unless
  the config says otherwise; `beads` keeps its existing `optional | required` setting,
  default optional. Its cases, which `checks` turns into its first test:

  | Case | Outcome | Gate |
  |---|---|---|
  | the check ran over its files, no violations | `passed` | green |
  | the check ran, a violation | `failed` | red |
  | nothing in the repo is the check's to look at, and no config asked for anything | `not-applicable` | green |
  | the repo has TypeScript source, and the rules' `sources` match none of it (a layout without `src/`, default config) | `failed`, naming the files outside scope | red |
  | TypeScript source at the repo root or in several top-level directories, `sources` set to cover it | `passed` | green |
  | a TypeScript file outside `sources` that is a test, a declaration file, or exempt with a reason | counted, not analyzed | green |
  | a configured glob or module matches no file | `failed`, naming it | red |
  | the same, declared `optional: true` | `not-applicable` | green |
  | `optional: true` on a glob that does match | as if not optional | as the check |
  | a required prerequisite is missing (`tsc`, biome, a declared command's tool) | `unavailable` | red |
  | an optional prerequisite is missing | `unavailable`, printed as a note | green |
  | a clone with `.beads/` but no database (CI, a fresh clone), `beads` optional | `unavailable` note, as today | green |
  | the same, `beads: required` | `unavailable` | red |
  | a tool present on a laptop, absent in CI | `unavailable` in CI | red if required: CI installs it, or the config makes it optional |
  | two declared commands, one ran clean and one's tool is missing | one line each: `passed`, `unavailable` | red if that one is required |
  | the check is turned off with a reason | `exempt` | green |
  | some files exempt with a reason, a violation in another | `failed` | red |

  Lands in `checks`' first PR; the others build on it.
- **Declared commands and file classes (owner `languages`, consumer `adoption`'s docs).**
  Executable source is a built-in list of extensions (`.c`, `.h`, `.cc`, `.cpp`, `.hpp`,
  `.py`, `.sh`, `.bash`, `.java`, `.go`, `.rs`, `.rb`, `.js`, `.mjs`, `.cjs`) plus any
  file git records as executable. The executable bit is a heuristic: a script with an
  unusual extension and no executable bit needs a declared command or a reasoned exemption,
  and the docs say so. A repo declares,
  in `shape.config.ts`, globs and the command that checks them (`{ files, run, optional? }`);
  `mshape check` runs each and reports its outcome under the contract. An executable source
  file that is neither TypeScript, nor declared, nor exempt with a reason fails `coverage`.
  Built in, with no configuration: `.beads/` (bd manages it), git's own files (`.gitignore`,
  `.gitattributes`, `.gitmodules`, `.gitkeep`) and symlinks. `.github/` is not exempt: a
  script there is executable source, and its workflows are structured data that must parse.
  Everything else is metadata: lockfiles, licences, dotfiles, `.gitkeep`, docs, images and
  other assets, held only to the size cap; JSON, YAML and TOML must parse. This repo and
  the template declare nothing and stay green. Lands in `languages`' first PR.
- **Tracked files (owner `languages`).** The `files` check: a size cap for tracked files,
  explicit per-path exceptions with a reason, `.env*` never tracked (the template's ignore
  list gets it too, through `adoption`), and each recorded vendored artifact's package and
  sha256 verified.
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
- **Vendored releases (owner `adoption`; `languages`' `files` check verifies them).** A
  dependency on another repo is its release tarball under `vendor/`, recorded in
  `shape.config.ts` with its package name and sha256.
  `mshape dep bump <name> <tarball> --sha256 <digest>` takes the digest from the upstream
  release, refuses a mismatch or a
  different package name, updates `package.json`, the lockfile and the record, and runs the
  gate; it never fetches. `init --from <tarball>` records its own vendored tarball the same
  way, so a repo born from a tarball passes `files` on its first gate.
- **`sync` and files the adopter wrote (owner `adoption`).** `sync` writes a shipped file
  (PRIME.md, the PR template, a skill) only where it is absent or one `sync` wrote before.
  A pre-existing file that differs is left alone: `sync` names it, says where its content
  goes (the repo's own decisions in AGENTS.md, old PR sections into the narrative), and
  `mshape sync --replace <file>` is the deliberate step. After that, sync is automatic. How
  `sync` knows which files it wrote is the implementation's choice; its tests cover a fresh
  clone and a version bump.
- **Session addresses (owner `loop`).** A session's address is the checkout it serves. Mail
  and live notices go only to registered sessions, by address. The inbox hooks list the
  unread mail of the session's address, or of its checkout when it has none: that is
  discovery for a session that missed registering, not delivery. Separately, `track rm`'s
  safety check counts any live session inside the worktree, registered or not (#30). Its
  cases, which `loop` turns into a table test first:

  | Case | Result |
  |---|---|
  | a session starts in a track's worktree | registered at `<track>` |
  | a session starts in the main checkout | registered at `main` |
  | a session at `main` runs `mshape review <n>` | moves to `review-<n>`; any other session at `main` is untouched |
  | a session at a track runs `mshape review <n>` | stays at its track; the review worktree is made or refreshed, no address moves |
  | a session at `review-<n>` runs `mshape review <n>` again | stays at `review-<n>` |
  | a session at `review-<n>` runs `mshape review <m>` | moves to `review-<m>`; `review-<n>`'s unread mail stays there |
  | `mshape review rm <n>` | that address's registrations are removed; its unread mail is listed first |
  | `/clear` or a restart in a review session | registers at `main` again, until `mshape review <n>` reruns |
  | a second live session registers where one already is | both registered; `register` warns |
  | no session identity (no session id or pid) | no address, and a note; never a guess |
  | which session to move is ambiguous | refuses, naming the sessions |
  | a live session that never registered (its hook didn't run) | no live notices; its inbox hook lists its checkout's unread mail, says it isn't registered, and says to run `mshape msg register` |
  | `track rm <name>` while an unregistered session runs in its worktree | refuses, naming the session |
  | a registration whose session ended | pruned by `send`, never by a read |

  `msg send main` and `msg send review-<n>` are valid; `inbox` and `read` work at each
  address; the inbox hooks read the session's address, not its directory, when it has one.
- **Migrations (owner `loop`).** `mshape track migrate` rewrites handoffs to the current
  format and prints what it changed; `track list` only reports a handoff that needs it.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `checks` | goals 1, 2 | The outcome contract, its case-table test and its output (first PR), including TypeScript source outside the rules' scope; `arch` at the root and across directories; `decode-strict` false positives (same-file options, property-less schemas, aliases, shadowing); `decodeStrict` helper variants for sync decodes; `host-access` per operation; `noConsole` from declared entry files | On the pinned application clone: with the default config the gate fails, naming the TypeScript outside `sources`; configured, the coverage table's TypeScript rows; `arch` finds its real cross-module imports; each remaining `decode-strict` and `host-access` finding is real, listed in the PR |
| `rules` | goal 3 | The adopter-rule interface and loader (first PR), with `mshape rules`, garden and rule-cases covering adopter rules; the enforcement-point pattern, documented with its example rule | An adopter rule in the clone fails on two different historical bugs of one class and passes on their fixes; a broken rule module fails the gate |
| `languages` | goal 4 | Declared commands and file classes (first PR); coverage of executable source; structured-data parsing; line budgets and garden over any text source; refs over any doc; the `files` check, including vendored-artifact verification | The clone's real secondary code: each declared command's outcome, red on a real compile error, `unavailable` without its toolchain; this repo green with no declared command, red with an undeclared script or one under `.github/scripts/`; fixtures for a non-compiling C file and a 30 MB binary as tests |
| `adoption` | goals 5, 7 (`dep bump`) | `docs/adopting.md` rewritten from a literal run on the pinned clone, with the four kinds of knowledge and each defect above; `sync` that leaves an adopter's files alone; the AGENTS.md gotcha for the outcome contract; `init` green from a checkout, tarball or npm, recording its vendored tarball, with versions that say what they contain; hooks before install; a release reproducible from its tag; `mshape dep bump`; the fresh-agent test over an adopted repo | A fresh agent following `docs/adopting.md` on the clone reaches a green gate, without an undocumented command, manual repair or change to monkeyshape; repos born from npm and from a tarball are green on their first gate; if delivered, `dep bump` refuses a wrong digest and moves a right one |
| `loop` | goals 6, 7 | Session addresses (the case table) with `track rm`'s safety kept, the inbox hooks by address, and `review-pr`'s step that moves the reviewer (P1); then `liveSessions` reads only, `mshape track migrate`, case tables for lifecycle facts in the `milestone` skill, and splitting `test/adapters/tracks.test.ts` (1172 lines, near the cap) by command (P2) | The maintainer's two-session run above; `track list` never rewrites a handoff |

**Order:** each track's first PR lands its interface (the outcome contract, adopter rules,
declared commands and file classes); the rest build on them, and nothing else waits.
`adoption`'s literal run happens last, against everyone's merged work (see Closing).

## Proposed beads (filed after approval)

- **checks:** the outcome contract, its case table and output; TypeScript source outside
  the rules' scope fails; `arch` at the root and across
  directories; `decode-strict` false positives; `decodeStrict` sync variants; `host-access`
  per operation; `noConsole` from declared entry files.
- **rules:** the adopter-rule interface and loader; `mshape rules`, garden and rule-cases
  over adopter rules; the enforcement-point pattern and its example.
- **languages:** declared commands and file classes; coverage of executable source;
  structured-data parsing; budgets, garden and refs over any text source; the `files` check
  and vendored-artifact verification.
- **adoption:** `docs/adopting.md` from a literal run, with the four kinds of knowledge;
  `sync` and files the adopter wrote; the outcome-contract gotcha; `init` green from any
  source, recording its tarball; hooks before install; a reproducible release; the
  fresh-agent test over an adopted repo; `.env*` in the template; `mshape dep bump` (P2).
- **loop:** session addresses, inbox hooks by address and `review-pr`'s move, with `rm`'s
  safety kept (P1); reads never prune, `track migrate`, case tables in `milestone`, the
  `tracks.test.ts` split (P2).
- **milestone:** the acceptance run, the 0.4.0 release, and the quick start from npm.

## Decision points

- **If adopter rules can't share the engine** without exporting the parser's internals,
  `rules` reports the smallest surface that works before building on it; the maintainer
  decides what becomes public.
- **If a declared command needs a toolchain CI doesn't have,** `languages` says so: the
  template's CI installs only Bun, and whether it grows a toolchain list is the maintainer's.
- **If the outcome contract turns a currently green adopter red** beyond the cases above,
  `checks` lists which prerequisites it would default to optional, and the maintainer
  approves the defaults.

## Deferred, with reasons

- Effect enforcement and monkeyshape's own Effect use: no reproduced failure on the path to
  adoption; direction in `docs/roadmap.md`, work in its deferred epic.
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
