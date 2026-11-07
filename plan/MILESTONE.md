# Milestone 4: the loop at scale

**Draft for approval, 2026-11-07.** Beads are filed only after the maintainer approves. Once
tracks start, the plan is frozen, except that a divergence the maintainer approves is
appended under "Amendments" with its date and reason.

## Why this milestone

Milestone 3 made monkeyshape safe to adopt, and two repos have since run on 0.4.0: an
existing application adopted it and ran its first milestone with four parallel tracks, and a
new repo was born and ran its first milestone with three. That is the first time the loop
ran at scale outside this repo, and its tracks, its reviewers and the maintainer reported
what got in the way. This milestone fixes what they hit. It comes before any new roadmap
goal because every repo pays for these on every track, and principle 8's consumer is now
real: each item below was hit by at least one real track.

What they found:

- **A PR was not one reviewed unit.** Tracks opened a PR and kept working on its branch, so
  commits landed mid-review; a message arriving mid-review made a track update the PR under
  its reviewer. PRIME.md and the `track` skill both say "a commit pushed while it is in review
  joins it", which reads as permission. Tracks asked for an endorsed local branch for the next
  bead's work instead. `track pr` refuses uncommitted changes and pushes the commit it gated,
  but runs the gate in the track's worktree, so ignored and untracked files there can make a
  gate pass that the pushed commit fails; when it fails, only its last lines are kept. Two
  tracks polled CI by hand, and a body-only edit reruns the gate (`gh pr edit` is broken on
  this GitHub host).
- **Agents didn't know rules that only the human docs state.** The PR size (1000 to 2500
  changed lines) is in PRIME.md but not in the `track` skill, where a PR is made. Tracks sent
  each other many short messages at the start, in cycles. A track's divergence from the plan
  was written into its own handoff, which no one else reads, and Amendments stayed empty for
  the whole of milestone 3: two divergences were recorded only at its boundary.
  `docs/workflow.md` states some rules no agent ever loads. One repo's tracks asked how to
  start (run the gate first, list the rules: `mshape rules` exists but no skill names it).
- **Decisions filled their budget with no test for what earns one.** The existing
  application raised its decisions budget to fit exactly; the merit test lives in
  `docs/workflow.md`, nothing says when to retire an entry or who reviews the change, and a
  decision names its enforcing test while the test doesn't name the decision, so an agent
  editing that test isn't told why it must stay.
- **Private data reached a public PR body** (#56, first revision: a fix timeline and a quoted
  commit line from a private repo). GitHub keeps a body's edit history. AGENTS.md calls this
  "can't be a check" because the names must not be in the repo; a list kept outside it can be.
- **A new track didn't start working.** A worktree has no `node_modules`, and `mshape check`
  looks for `tsc` and biome only there (`src/adapters/workspace.ts`), so a fresh track's gate
  is red until someone runs `bun install` (three tracks here, one in each adopter). After a
  restart, `bun` was missing from the hooks' PATH in three sessions: no registration, no mail.
  `bun test` found tests inside a linked shared-data directory (all three tracks of one
  adopter). Two tracks' temp-file cleanup could match each other's files.
- **The human starts each step from a different directory** (`zdw`): the main checkout for
  `/roadmap`, `/milestone` and `/review-pr`, a worktree for `/track`. The maintainer has no
  way to tell every track one thing at once, and a message body with an apostrophe broke shell
  quoting twice.
- **Checks that misfit a living adopter:**
  - setting `arch.allowedPackages` replaces the default `effect`, though
    `docs/adopting.md` says the list adds to it (`src/schemas/config.ts`);
  - `refs/*` has no per-rule `off` or `allow`, as `rules/*` does;
  - a file over its baseline count reports every occurrence, not the new one;
  - with no `bd` (CI), the beads checks are skipped though `.beads/issues.jsonl` is committed;
  - a declared command's glob can be wider than what the command checks, and passes;
  - a local rule's own file has no place in the module map;
  - `track list` advises `bd defer` for a bead left open after its PR, and the `beads` check
    then flags the deferred bead for keeping its `track:` label, so the track is never done;
  - PRIME.md's "`bd sync` where shared" made `bd` offer to adopt a remote, which looked like
    publishing;
  - `init`'s checkout test is red when this repo's HEAD sits on a release tag (`alg`), and
    three reported P3s (`07u`, `2s3`, `737`).

## Goal, and how we'll know

**The cut line.** A track in any adopter goes from `track new` to a merged PR without a
broken environment, a PR changed under its reviewer, a rule it couldn't have known, or a
private name leaving the machine. Goals 1, 4 and 5, and goal 2's skill text, are that (P1).
The rest is P2: worth doing if contained, dropped with a reason if not.

1. **A PR is one reviewed unit.** A track has one open PR; its next work is local commits on
   a branch that isn't pushed until the PR merges. `track pr` refuses to push while a review
   of the PR is in progress. The gate runs on a clean checkout of the exact commit pushed,
   and a failure shows the failing tests and keeps the full log. `track pr --wait` waits for
   CI; a body-only refresh skips the gate when HEAD hasn't moved since it last ran; and it
   warns when the branch is behind `main` or conflicts with it.
2. **Agents learn the loop's rules where they act.** The `track` skill states the PR size and
   its exceptions (a smaller PR that unblocks another track or ends the track), the one-PR
   rule with its local branch, what makes a message worth sending, that a handoff is the
   track's own, and that a divergence goes to `msg send main`. It starts with the gate and
   `mshape rules`. The `milestone` skill keeps its session open for the milestone, reads
   `main`'s mail and appends approved divergences. `review-pr` runs the repo's real-data
   probes, which AGENTS.md names. PRIME.md says neither "joins it" nor an unsafe `bd sync`.
   `docs/workflow.md` says it is for humans, and agents don't read it.
3. **A decision earns its slot.** The shipped `DECISIONS.md` header holds the merit test and
   the lifecycle; every file a decision's `Enforced by` names cites the decision's slug, and
   a check fails when one doesn't; `review-pr`'s Fit applies the merit test to any decision a
   PR adds or retires; at each boundary, each bd memory is promoted or deleted.
4. **Nothing private leaves the machine.** A denylist kept outside every repo is checked
   before `track pr` pushes (the PR body and the commit messages) and before `review-pr` posts
   a review; a match refuses and names the term's position, never posting.
5. **A new track starts working.** `track new` installs dependencies in the new worktree;
   `mshape check` finds `tsc` and biome in the worktree or up to the main checkout's; the
   hooks call `bun` by an absolute path; the template ships `bunfig.toml` with the test root,
   so `bun test` never searches shared data.
6. **The human starts any step from anywhere, and reaches every track.** `/track <name>`
   started in the main checkout moves the session to that track's address and works in its
   worktree; `msg send --all` reaches every track; `msg send --body-file` reads a body from a
   file. A per-track temp directory (P2).
7. **Checks fit a living adopter.** `allowedPackages` adds to `effect`; `refs/*` takes `off`
   and `allow` per rule; a file over its baseline count reports the new occurrence; with no
   `bd`, the beads checks read the committed export and say so; a declared command receives
   the files its glob matched; local rules have a home in the module map; `track list`'s
   advice for an open bead agrees with the `beads` check; `alg`, `07u`, `2s3` and `737` are
   fixed or closed with a reason.

**Acceptance on real data:**
- **In each adopter** (the existing application and the new repo, both private; recorded as
  counts and outcomes in the closing PR, never their content), on the release that ships
  this milestone:
  - a new track's first `bun run check` is green with no manual step, including after its
    session restarts;
  - a track opens a PR, is reviewed, and merges with no commit pushed between the review's
    start and its findings; one `track pr` attempted mid-review is refused;
  - each adopter's handoffs, at its next boundary, show no rule a track learned only from the
    human or a review;
  - the existing application's gate on its current `main`, with `allowedPackages` set, still
    allows `effect`, and a new occurrence over its baseline is reported alone; its CI, with no
    `bd`, runs the beads checks from the export.
- **The maintainer's run:** a `track pr` whose body holds a denylisted term is refused before
  anything is pushed; `/track <name>` started in the main checkout works in that track and
  receives its mail; `msg send --all` reaches every live track.
- **Releases:** 0.4.1 as soon as goal 2's first PR merges, so adopters' running tracks get the
  skill text; 0.5.0 at the end, its quick start working from npm.

**Closing:** as milestone 3's: a P1 defect the acceptance finds is fixed before the milestone
closes; a P2 limitation is deferred with a reason and the maintainer's yes.

## Non-goals

- **A citation syntax into a frozen design document** (`refs.frozenDocs`): it would keep code
  citing a long design by section, the decay principle 5 names. An adopter keeps the document
  as history and burns its section citations down under the baseline. Settled in milestone 3.
- **A check that a repo's old decision records are each superseded, promoted or binding:**
  one consumer, and migration bookkeeping; an adopter rule can do it.
- **Matching bead ids written without their prefix:** short ids collide with code vocabulary;
  an adopter that cites them so writes an adopter rule for its own syntax (one exists).
- **Locks on shared data** (`mshape lock`): one consumer; revisit when a second repo's tracks
  write shared data at once.
- **`mshape track adopt`** (existing parallel work into tracks): its one consumer has adopted;
  revisit at the next adoption of an existing repo.
- **Stacked PRs:** the local branch keeps one reviewed unit; stacks multiply review.
- **Moving decisions next to their enforcement:** no failure seen of an agent undoing a
  decision because its reason lived in another file; the back-link (goal 3) puts the slug in
  the enforcing file. Revisit if agents undo decisions despite it.
- **Capping review rounds:** the maintainer's call: not a problem worth a mechanism.
- **Effect enforcement (`rrn`), `mshape validate` (`97o`), agents other than Claude Code:**
  unchanged; no adopter's track hit them.

## Where we are

| Area | Today |
|---|---|
| Pushing during review | invited by PRIME.md and the `track` skill; nothing refuses it |
| Where `track pr` gates | the track's worktree, ignored and untracked files included |
| PR size in the `track` skill | absent (PRIME.md only) |
| Divergences | written in the track's own handoff; Amendments empty for all of milestone 3 |
| Decisions | one adopter at budget (17, raised to fit); merit test only in `docs/workflow.md`; links one way |
| Private names | AGENTS.md prose; one leak (#56's first revision) |
| A new track's first gate | red until `bun install` (three tracks here, one per adopter) |
| Starting `/track` | only from the track's worktree |
| `allowedPackages: [...]` | drops `effect` |
| Beads checks in CI | skipped with a note |

## What changed since milestone 3, and why

- Milestone 3 shipped (0.4.0): the outcome contract, checks on real layouts, adopter rules,
  declared commands and the `files` check, adoption as written, addresses for `main` and
  reviews. Its plan is in `notes/2026-11-07-milestone-3.md`, with the two divergences that
  never reached Amendments recorded there.
- The maintainer decided: divergences go to `msg send main`, and the session that wrote the
  plan stays open to receive them; a handoff is its own track's; `docs/workflow.md` is for
  humans, and what agents follow is in PRIME.md, the skills, file headers and check messages;
  review round counts are not a problem to solve; decisions stay in `DECISIONS.md`, with a
  merit test, a lifecycle and a back-link.

## Phase 0: the milestone-3 boundary (before the tracks start)

1. Remove milestone 3's five tracks (all `done yes`, no unread mail).
2. File the epic and the beads below; take `alg`, `07u`, `2s3`, `737` and `zdw` into it.

## Interfaces the tracks share

- **Ownership of files:**
  - `skills`: `skills/` (all five) and their synced copies; `template/.beads/PRIME.md` and
    this repo's copy; `template/DECISIONS.md`, `template/AGENTS.md`; `docs/workflow.md`,
    README, AGENTS.md; `src/core/conventions.ts`.
  - `prs`: `src/{core,adapters}/trackPr.ts`, `src/adapters/reviews.ts`, a new denylist module
    and its `mshape scan` command, `.github/workflows/pr.yml` and the template's copy.
  - `env`: `src/{core,adapters}/tracks.ts`, `src/{core,adapters}/mail.ts`,
    `src/{core,adapters}/notices.ts`, `src/core/layout.ts`, `src/core/hooks.ts`,
    `src/adapters/workspace.ts`, `template/bunfig.toml`.
  - `checks`: `src/schemas/config.ts`, `src/core/{arch,refs,ratchet,beads,decisions,coverage}.ts`,
    `src/adapters/{baseline,commands}.ts`, `test/integration/init.test.ts`, and any file not
    listed here (others send it changes).
  - Shared tables, additions only: `KINDS` in `src/core/check.ts`, the command table in
    `src/cli/main.ts`, `test/core/ruleCases.test.ts`.
  - Text one track needs in another's file goes as a message with the exact wording.
- **The PR size (owner `skills`):** stays in `conventions.ts`; the `track` skill states it,
  and a test holds the skill's numbers to `conventions.ts`.
- **The denylist (owner `prs`, consumers `skills` and every adopter).** One term per line,
  `#` comments, matched case-insensitively as a substring, in
  `~/.config/monkeyshape/denylist` (per machine: the names span every repo there) and, if it
  exists, `<git common dir>/monkeyshape/denylist` (per clone). Neither is ever in a repo.
  `mshape scan <file>` exits 1 on a match, printing the line and column and the matched
  term. `track pr` scans the body and every commit message it would push; the `review-pr`
  skill scans a review before posting. Cases, which `prs` turns into its test first:

  | Case | Result |
  |---|---|
  | no denylist file anywhere | passes, with a note that none is configured |
  | a term in the PR body | refuses before pushing; names line and column |
  | a term only in a commit message being pushed | refuses before pushing; names the commit |
  | a term in a commit already on the remote | not scanned: only what this push adds |
  | a term differing in case | matches |
  | a blank line or a `#` comment in the list | ignored |
  | both lists exist | both apply |

- **A review in progress (owner `prs`, consumer `env`'s registry).** A PR's review is in
  progress when a live session is registered at `review-<n>` and no review was submitted on
  the PR after its head commit was pushed. Cases, `prs`' test:

  | Case | `track pr` |
  |---|---|
  | no session at `review-<n>` | pushes |
  | a live reviewer, no review posted since the head was pushed | refuses, naming the session |
  | a live reviewer, a review posted after the head (findings to answer) | pushes |
  | the reviewer's session ended without posting | pushes, with a note |
  | `--body-only`, HEAD unchanged since the last gate | edits the body, no push, no gate |
  | `--body-only`, HEAD moved | refuses: the Gate section would be false |
  | the branch is behind `main`, or conflicts with it | pushes, with a warning naming which |

- **Moving a session to a track (owner `env`, consumer `skills`' `track` skill).**
  `mshape track enter <name>` moves the calling session's registration to `<name>` and prints
  the worktree path; the skill then works there. Cases, `env`'s test, extending milestone 3's
  address table:

  | Case | Result |
  |---|---|
  | a session at `main` runs `track enter <name>` | moves to `<name>`; any other session at `main` is untouched |
  | a session at `<a>` runs `track enter <b>` | moves to `<b>`; `<a>`'s unread mail stays at `<a>` |
  | `track enter` a track that doesn't exist | refuses, listing the tracks |
  | `track enter` with no session identity | refuses with a note: nothing to move |
  | a session started in the worktree | registered at `<name>` as today; `track enter` is a no-op |
  | `track rm <name>` with a moved session live | refuses, naming it (the session counts as in the track) |
  | `/clear` or a restart of a moved session | registers by its directory again, until `track enter` reruns |

- **Beads from the export (owner `checks`).** A source is chosen and named in the outcome
  line. Cases, `checks`' test:

  | Case | Source | Outcome |
  |---|---|---|
  | `bd` and a database | the database | as today |
  | no `bd`, `.beads/issues.jsonl` committed | the export | as the check finds, its line saying "from the export" |
  | no `bd`, no export | none | `unavailable`, as today (note unless `beads: required`) |
  | `bd` present, no database, an export | the export | as above, with bootstrap's note |
  | an export that doesn't decode | none | `failed`, naming the file |

- **Baseline over its count (owner `checks`).** Cases, its test:

  | Case | Reported |
  |---|---|
  | one occurrence added on lines this branch changed | that one |
  | the count rose, none on changed lines (moved code) | every occurrence, with a note that none is new by line |
  | the count fell | nothing; `baseline --tighten` suggested as today |
  | no merge base (a fresh repo) | every occurrence |

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `skills` | goals 2, 3 | First PR (P1, released as 0.4.1): the `track` skill's PR size and exceptions, one PR with a local branch, salient messages, the handoff as the track's own, divergences to `main`, starting with the gate and `mshape rules`; PRIME.md without "joins it" and with a safe `bd sync` line; the `milestone` skill's open session and amendments from mail; `docs/workflow.md`'s audience line. Then: `review-pr`'s real-data probes and its Fit on decisions; the `DECISIONS.md` merit test and lifecycle; memories promoted or deleted at the boundary; the size test | In each adopter, the next boundary's handoffs show no rule learned only from the human or a review; 0.4.1 ships the first PR |
| `prs` | goals 1, 4 | The denylist and `mshape scan` (P1); a review in progress refuses a push (P1); the gate on a clean checkout of the pushed commit, with failing tests and a kept log (P1); `--wait`, `--body-only`, the behind or conflicting warning (P2) | The maintainer's denylist run; one mid-review `track pr` refused in an adopter; a PR merged there with no push mid-review |
| `env` | goals 5, 6 | `track new` installs; tools found up to the main checkout; hooks call `bun` absolutely; `bunfig.toml` in the template (P1); `track enter`, `msg send --all`, `--body-file`; `track list`'s advice for an open bead (sent to `checks` as the wording it needs); a per-track temp directory (P2) | A new track's first gate green, after a restart too, in each adopter; the maintainer's `/track` from main and broadcast |
| `checks` | goals 3, 7 | `allowedPackages` adds to `effect` (P1); the decision back-link check; `refs/*` per rule; the new occurrence over a baseline; beads from the export; declared commands receive their files; a module-map home for local rules; the `beads` check and `track list` agreeing on a deferred bead; `alg`, `07u`, `2s3`, `737` (P2) | The existing application's `main`: `effect` allowed with the list set, a new occurrence reported alone, CI's beads checks from the export |

**Order:** `skills`' first PR goes first and is released as 0.4.1; nothing waits on it.
`prs` lands the denylist before the in-progress refusal. `env` lands `track enter` before
`skills` writes the `track` skill's step for it (by message). Nothing else waits.

## Proposed beads (filed after approval)

- **skills:** the `track` skill's rules and PRIME.md (P1, first PR); the `milestone` skill's
  open session; `review-pr`'s probes and decision Fit; the `DECISIONS.md` header; memories at
  the boundary; the PR-size test; `docs/workflow.md`'s audience line.
- **prs:** the denylist and `scan` (P1); in-progress refusal (P1); the clean-checkout gate and
  its log (P1); `--wait`; `--body-only`; the behind or conflicting warning.
- **env:** install in `track new`, tool resolution, absolute `bun` in hooks, `bunfig.toml`
  (P1); `track enter` (`zdw`); `msg send --all` and `--body-file`; the open-bead advice; the
  temp directory.
- **checks:** `allowedPackages` (P1); the back-link check; `refs/*` per rule; new occurrence;
  beads from the export; commands receive files; local rules' home; deferred-bead agreement;
  `alg`, `07u`, `2s3`, `737`.
- **milestone:** the acceptance run, 0.4.1 and 0.5.0.

## Decision points

- **The denylist's place:** per machine (`~/.config`), with an optional per-clone list. If an
  adopter needs a list shared by its contributors, that is a private file in a private place,
  and the maintainer's call.
- **`track enter` and the agent's directory:** the agent's working directory is set by its
  launch; if Claude Code won't let a skill work reliably in another checkout, `env` reports
  before building on it, and the maintainer decides.
- **The decisions budget:** raising an adopter's is the maintainer's; the header says so.

## Deferred, with reasons

- Frozen-document citations, an old-decisions log, prefix-less bead ids, `mshape lock`,
  `track adopt`, stacked PRs, decisions next to their enforcement: see Non-goals.
- `725` (decode-strict across files) and `ede` (`dep bump`'s no-op exit): deferred at
  milestone 3's close with the maintainer's yes; unchanged.
- `rrn` (Effect), `97o` (`validate`), `v56` (agentic layer), `hh2`, `8h4`, `nm9`: no adopter's
  track hit them.

## Spend

None: no model calls in this milestone's code.

## Amendments

None yet.
