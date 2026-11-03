# Milestone 2: conventions as code

**Draft for approval, 2026-11-02; revised after review by the three milestone-1 tracks
(PR #21).** Beads are filed only after the maintainer approves. Once approved, the plan is
frozen for the milestone, except that a divergence the maintainer approves is appended under
"Amendments" with its date and reason, so the plan never goes stale.

## Why this milestone

monkeyshape exists because prose is fragile: it works only if it is loaded and noticed, it
goes stale, and docs that restate docs spread their errors. Its answer is mechanism over
prose, one home per fact, and a budget for what is loaded automatically (docs/roadmap.md,
Principles).

Milestone 1 applied that answer to **code** and shipped the working loop. But it shipped the
loop's **conventions** as prose, and they decayed in exactly the ways the thesis predicts.
The tracks' retrospectives and six read-only audits found:

- **No owner, many copies.** The PR body's sections exist in five versions; the three tracks
  wrote three dialects, and the `milestone` skill's retrospective reads PR bodies by section
  name. Decision authority exists in five versions, and a skill cites a spend cap defined
  nowhere.
- **The wrong moment.** A new repo loads none of the conventions; only `/roadmap` is named in
  anything it loads. The `track` skill sends agents to `docs/workflow.md`, which isn't in a
  born repo, for the PR size. The `bd prime` hook, the largest text loaded every session,
  tells agents not to push, contradicting AGENTS.md.
- **State recorded by hand.** Cross-track messages were pull-only and arrived only when the
  maintainer relayed them; one session ran four days without a restart and never saw a
  message sent on the second. Handoffs only grew: finished tracks still say `Status: active`.
  Beads stayed open after their decision shipped, and a mislabelled bug made a track look done.
- **Review looked down, not up.** Reviews caught real bugs on nearly every PR, but nothing asks
  a reviewer to read the milestone, the track's charter or the bead, so no review asked
  whether a change fit the milestone's intent or duplicated something.

This milestone applies monkeyshape's thesis to its own conventions, at the 95% bar: where a
convention is machine-checkable, it gets one owner and a check; where it is judgement, it is
worded for its reader where that reader needs it. "One home per fact" means one owner, not
that every mention of a convention is a defect. It comes before the first real adoption
(`iqf.14`): that run should test the loop, not trip over contradictions we already know about.

## Goal, and how we'll know

1. **One owner per machine-checkable convention.** The PR body's sections, the PR size
   default, the track branch and git authority each have one source in code or in one
   shipped file, and every generated or shipped copy is checked against it. Prose that
   explains a convention for its reader is not policed.
2. **Delivered at the moment of need.** What every session needs arrives at session start for
   any agent; what one step needs is in that step's skill or printed by the command used then.
   No skill sends an agent to another doc for a rule.
3. **Messages reach a running agent.** A message to another track is stored durably, and its
   subject is pushed at once into every live session of that track, **including an idle one**,
   through Claude Code's native cross-session messaging. The recipient decides when to read
   the body; the notice never marks it read. With no live session, it waits and is shown at
   the next session's start.
4. **Status is derived, not remembered.** Whether a track is done, whether a bead's work has
   merged, whether a handoff is stale: computed from git, PRs and beads, never written by hand.
5. **Review looks up.** A reviewer reads the milestone's why and non-goals, the track's
   charter and the PR's beads before the diff, and says in the review whether the PR fits
   them.

**Acceptance on real data:**
- **What a fresh agent actually loads.** In a repo freshly made by `init`, and in this repo,
  a test runs the SessionStart hook commands exactly as the generated `.claude/settings.json`
  configures them (CI installs a pinned `bd`, so it runs there, not only on a laptop), then asserts that their output plus AGENTS.md plus the `track` skill state
  the PR size, how to open a PR, that agents push and open PRs, the decision authority, and
  how to message another track. It must fail on today's `main`.
- **Shipped copies agree.** PRIME.md and the PR template in a born repo and in this repo
  match what the package ships, and the check fails when one is edited by hand.
- **Two real Claude Code sessions, in two tracks** (run by hand by the maintainer, recorded in
  the PR): `mshape msg send` from one makes an **idle** recipient show the subject notice with
  no new user prompt; the recipient defers it, keeps working, and later reads it with
  `mshape msg read`; the message stays unread until then. A message to a track with no live
  session, or a stale registration, waits and is shown at the next session's start. The test
  suite covers the same contract with a fake socket; the acceptance is real delivery, not a
  successful write.
- **The tracks use it.** From the moment the mailbox merges, every track messages the others
  through `mshape msg`; the maintainer relays nothing the mailbox could have carried.
- **A release is published** that ships this milestone's template changes to adopters, and
  the README quick start works from npm on a clean machine.

## Non-goals

- **The remaining starter rules, the agentic layer, `mshape validate`** (deferred epics
  `hh2`, `v56`, `97o`): no consumer yet.
- **Adopting an existing repo** (`36f`): after a new repo has been born the new way.
- **Reworking the review process:** rounds, severities and nits are settled in `review-pr`
  and work. This milestone adds the look-up and an author-side self-check, nothing else.
- **Changing the PR size default:** this milestone moves it to where agents see it, not what
  it is.
- **A rendering or templating framework for skills,** and checks that police prose: shipped
  and generated copies are checked, not prose that mentions a convention.
- **Live delivery for agents other than Claude Code.** The transport is replaceable and the
  mailbox readable by any agent, but Claude Code is the only live-delivery harness now.

## Where we are

| Area | Today |
|---|---|
| PR body | 5 section lists; no PR template in this repo; `gh pr create --body-file` bypasses GitHub's template anyway |
| Session-start context | `bd prime`'s default text (about 6.5 KB, unbudgeted) contradicts AGENTS.md on pushing, bead-first, markdown tracking and when to close beads |
| A born repo | loads AGENTS.md (no loop, no PR rules) and the contradicting hook; bare `mshape` isn't on PATH for skills or hooks; no remote, so the first `/roadmap` can't push |
| Messages | appended to other tracks' handoffs; pull-only; direction varies |
| Status | handoff `Status` set by hand and stale; beads closed by hand; bead ids in commits used inconsistently |
| Review | `review-pr` reads AGENTS.md and the diff, not the milestone, charter or bead |
| npm | 0.1.0, without `init`; the README quick start fails |

## What changed since milestone 1, and why

- Held and kept as they are: one open PR per track, from `track/<name>` (`5b4`); PR size as a
  batching default, not a gate; nits open until settled; uncapped rounds.
- Settled during milestone 1 and now in code: open beads block `track rm`, and a failing `bd`
  makes it refuse even with `--force` (#16); merged is judged against upstream `main`,
  including squash and rebase merges, and `rm` fetches first (#20); `bd init`'s commit is
  folded into `init`'s first commit (`31v`); a track starts with `mshape track new` and
  `/track` (`y0p`).
- The `milestone` skill derived the number of tracks from a habit ("two to four"); it now
  derives it from the work, up to about five (this PR). This plan uses four for that reason.

## Phase 0: the milestone-1 boundary (before the tracks start)

Done by the maintainer and the planning agent, not a track, in this order:
1. Check whether bd's telemetry (`bd config list`: metrics on, an external endpoint) is
   global and whether born repos inherit it. Anything that leaves the machine is the
   maintainer's call; settle it before a release ships.
2. Publish 0.2.0 from `main` (the quick start then works), with an unknown command saying
   `unknown command` before the help.
3. Close `31v` and `y0p` (resolved), and take `iqf.14` off `track:init` (it stays a child of
   `monkeyshape-iqf`), since open labelled beads block `track rm`. For each milestone-1
   handoff, promote or delete each lesson (to AGENTS.md, a check, or the code; the skills
   track's "probe a new check with valid input" is covered by `review`'s self-check and is
   deleted). Then `mshape track rm` all three tracks **without** `--keep-handoff`, so a new
   track that reuses a name (`tracks`) starts from a stub, not the old handoff.
4. Archive milestone 1's plan to `notes/` (done in this PR) and replace it with this one.
5. Land the groundwork every track builds on, so no track waits on another:
   - `src/cli/main.ts` gets a command table, with the help generated from it; each track then
     adds only its own entries.
   - `src/core/layout.ts` gains the mailbox and session-registry paths under git's directory,
     beside the handoffs store.
   - One way for hooks and skills to invoke `mshape`, chosen and tested from a born repo and
     from a worktree inside it; every track uses it.
   - `.claude/settings.json` (here and in the template) is generated from a hook list in code;
     each track adds only its own entries.
6. Cut `docs/roadmap.md` back to direction: keep the status table, scope, principles and
   goals; move anything still unique about shipped conventions to where it now lives;
   delete the rest.

## Interfaces the tracks share

Settled before the tracks start. A change goes to the other tracks by `mshape msg` (once it
exists) and to the maintainer.

- **Ownership of code and files,** so no two tracks edit the same file:
  - `messaging`: `mshape msg` and everything under it (the mailbox, the session registry, the
    `Notifier`), and its own entries in the hook list.
  - `tracks`: every `mshape track *` command (`track pr` included),
    `src/{core,adapters}/tracks.ts`, `src/core/handoff.ts`, `src/core/layout.ts` after
    Phase 0, the PR-body workflow (`.github/workflows/pr.yml`, here and in the template, a file
    of its own), the beads-ownership check, and the `track` and `handoff` skills.
  - `conventions`: `src/core/conventions.ts`, `mshape sync`, `init`, the template (except
    `pr.yml`), the hook-list generator and the generated `.claude/settings.json`, CI's
    `ci.yml`, PRIME.md, the PR template, `docs/workflow.md`, README, AGENTS.md.
  - `review`: the `review-pr`, `milestone` and `roadmap` skills, and the rule-cases and
    Markdown reference tests.
  - `src/cli/main.ts` and the hook list: each track adds only its own entries (both are
    tables after Phase 0, so additions don't collide).
  - A track that needs a change in another's file sends it as a message or a bead.
- **`src/core/conventions.ts` owns the machine-checkable values:** `PR_SECTIONS` (name,
  purpose, required); the PR size default, which `mshape track pr` prints when it opens a PR;
  the gate command (`bun run check`), which `track pr` runs; and the track branch, re-exported
  from `layout.ts`. A value lives here only if code or a
  check reads it. Docs and skills word a convention for their reader; nothing renders them.
- **Always-loaded files:** what monkeyshape decides goes in `.beads/PRIME.md`; what the repo
  decides goes in AGENTS.md. bd's SessionStart hook stays; PRIME.md (about 60 lines,
  budgeted) replaces its default text, so the hook agrees with AGENTS.md, and bd still
  appends memories. `init` writes PRIME.md and sets `agent.profile team-maintainer` as a
  fallback. `mshape sync` is the one command that refreshes skills, PRIME.md and the PR
  template (`skills sync` becomes its alias); it, the manifest and the check all compare
  against the shipped copy. AGENTS.md stays repo-owned with one pointer line to PRIME.md.
- **Running `mshape` from hooks and skills:** every generated hook and every skill invokes
  `mshape` the same way, chosen by `conventions` and tested from a freshly initialized repo
  and from a track worktree inside it (a package script alone doesn't put `mshape` on a
  hook's PATH).
- **The PR body:** `.github/pull_request_template.md` is generated from `PR_SECTIONS` in this
  repo and in born repos, and `conventions` exports a function that builds the skeleton.
  `mshape track pr` (owned by `tracks`) pushes `track/<name>` and creates the track's PR
  from that skeleton, or updates it **without overwriting** the agent's narrative and
  evidence: it fills only machine-known fields, each from a verified fact (the gate's output
  from a run it does then, never a cached result, though it takes about 90 seconds here;
  changed lines from `git diff`). The PR's Beads section is the record
  of which beads a PR works on: the agent lists them, `track pr` checks that each exists, and
  a bead listed in a merged PR but still open is flagged by `track list`, which already talks
  to GitHub; when `gh` can't answer, it shows "unknown" with a note, never "fine". CI's
  `pr.yml` checks the body's required headings on **every** PR from a `track/*` branch,
  however it was opened; other PRs, like this one, are unaffected.
- **The mailbox is the durable source of truth.** One file per message,
  `<common>/monkeyshape/mail/<track>/<id>.json`, under git's directory so `git clean` can't
  delete it, and written atomically so concurrent senders can't lose messages. A message has
  `id`, `from`, `to`, `subject`, `body` and `created`; reading it moves it to `read/` (atomic
  rename). Reading is consumption by the **track**: once any of its sessions reads a message,
  it is read for all of them. Only `mshape msg read <id>` marks a message read. Commands:
  `mshape msg send <track> --subject <subject> [body]`, `mshape msg inbox`,
  `mshape msg read <id>`. A sender outside a track writes `from` as `main` (the main
  checkout) or `review-<n>` (a review worktree). `send` and `register` create their
  directories on first use. Handoff Messages sections are retired.
- **Live notices go through Claude Code's native cross-session messaging.**
  - **Registration:** a SessionStart hook runs `mshape msg register`, which records the
    session against its track (from `mshape track current`) with its
    `CLAUDE_CODE_MESSAGING_SOCKET`, session id and process, in
    `<common>/monkeyshape/sessions/<track>/<session>.json`. Outside a track it does nothing.
  - **Send:** writes the message first, then sends every live session registered for the
    track one line: `[mshape] Message from <from>: <subject> (mshape msg read <id>)`. Never
    the body.
  - **Stale and multiple registrations:** a registration whose process is gone or whose
    socket doesn't answer is pruned at send time; every live session gets the notice. A failed
    notice never fails the send: the mail waits.
  - **Restarts:** the same SessionStart hook prints the subjects of unread mail.
  - **Until live notices land:** a `UserPromptSubmit` hook also prints unread subjects, from
    the day the mailbox merges. It covers long-running sessions at their next prompt; it
    doesn't replace native delivery to an idle session or change that acceptance.
  - **Replaceable transport:** notices go through a `Notifier` service; the Claude Code socket
    is its one implementation now, behind a check of the session registry's protocol version.
- **A track is done** when no open bead carries its label, its branch is merged into upstream
  `main`, and no PR from `track/<name>` is open. `track list` derives it; the `milestone`
  skill prunes by it. When a fact can't be read (no `bd`, no `gh`), done is "unknown", never
  yes.
- **Beads that can't be seen:** one shared fact (beads exist, but their state is unknown),
  two explicit policies. `mshape check` reports it as a note, as today, so adopters without
  `bd` keep a working gate. `track rm` refuses, because removal can't be undone. `beadsBlocker`
  stays the one place that reads the state.
- **Handoff format:** the `Status` line is removed (a stub is a handoff with an empty
  charter; "done" is derived as above), and so is `Messages`; existing handoffs are migrated
  when the parser changes. The Charter opens with `Serves: goal step <n>, because ...`, then
  `Out of scope:` and `Done means:`. Its writers change with it: the `milestone` skill stops
  writing `Status: active` and writes those lines from this plan's track table (`review`),
  and `docs/workflow.md` stops describing stubs by `Status` (`conventions`).
- **Refs on plans and notes:** `plan/` describes what doesn't exist yet and `notes/` is
  history, so both get form checks only (split code spans, `§` citations), never a check that
  a path or command exists.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `conventions` | goals 1, 2 | Kept small, so nobody waits on it. `conventions.ts`; PRIME.md, `mshape sync` and its checks (shipped copy, hook present, budget); the PR template and the skeleton function; the hook-list generator and `ci.yml` (which installs a pinned `bd`); a born repo ready for the first chat (`init` prints the `gh repo create --source . --push` step, sets `agent.profile`, and its `package.json` doesn't record a machine-specific tarball path); the AGENTS.md split, with a dogfooding section in this repo's; `docs/workflow.md` without `Status`; the fresh-agent test; form-only refs checks on `plan/` and `notes/`, and the new-repo refs test built from `template/` | The fresh-agent test passes in CI, and fails on today's `main`; shipped copies are checked |
| `messaging` | goal 3 | The mailbox first (`send`, `inbox`, `read`, and its SessionStart and `UserPromptSubmit` entries in the hook list), so every track uses it early; then a spike that proves native socket delivery into a real idle session and reports; then `register`, the session registry, stale pruning and the `Notifier` with its Claude Code implementation | The two-session acceptance above, including the idle recipient; a message to a track with no live session waits and is shown at its next session |
| `tracks` | goals 2, 4 | Every `track *` command: `track pr` (prints the PR size, runs the gate fresh, fills verified fields, never overwrites the narrative) and `pr.yml`, which checks every `track/*` PR; `track list`'s derived done status, merged-PR reconciliation (unknown, never fine, without `gh`) and handoff hygiene warnings; `track new` from upstream `main`; `track rm` refusing when beads can't be seen, as above. The handoff format change and migration. The offline part of the beads-ownership check in `mshape check`: open beads with no `track:` label, deferred beads with one, `TODO(<id>)` on closed beads. The `track` and `handoff` skills: the mailbox, the self-check from `review`, and no pointer to `docs/workflow.md` for the PR size | `track list` shows finished tracks as done, and unknown when it can't tell; `track pr` keeps a hand-written narrative; `rm`'s refusal says why; each ownership case is flagged |
| `review` | goal 5 | First, as a small PR of its own: a test that every rule id `mshape check` can report (the rules registry and each check's violation kinds) has a must-fail and a must-pass case, and the Markdown reference-parser test. `review-pr` reads the milestone (why, non-goals, the track's row), the track's charter and the PR's beads before the diff; every review body has a short "Fit" section: does it serve its beads and goal step, is anything outside them (filed as a bead, as nits already are), is it redundant with existing code or docs, is there prose where a check belongs. The author self-check text for the `track` skill (re-run the reviewer's probes before replying "fixed", try to break the fix with valid input), handed to `tracks`, which owns that file. The `milestone` and `roadmap` skills write the plan sections this plan uses (why, non-goals, how tracks serve, amendments); `milestone` writes the new charter lines and stops writing `Status` | The rule-cases test fails when a rule loses its must-pass case; a plan written by `/milestone` has every section above; a manual review of a deliberately out-of-scope PR flags it under "Fit" |

**Order:** Phase 0's groundwork lands before any track starts. `review`'s rule-cases test is
its first, small PR, and lands before any track adds a check. `messaging`'s mailbox lands
before its socket work, and `tracks`' skills adopt it once it merges. `conventions.ts` lands
in `conventions`' first PR. Nothing else waits on another track.

## Proposed beads (filed after approval)

- **conventions:** `conventions.ts`; PRIME.md, `mshape sync` (with `skills sync` as its
  alias) and its checks; how hooks and skills invoke `mshape`, tested from a born repo and a
  worktree; the PR template and skeleton function; `init` for the first chat (the
  `gh repo create` step, `agent.profile`, no machine-specific tarball path); the AGENTS.md
  split and the dogfooding section; `docs/workflow.md` without `Status`; the hook-list
  generator and `ci.yml` with a pinned `bd`; the fresh-agent test; form-only refs checks on
  `plan/` and `notes/`, and the new-repo refs test built from `template/`.
- **messaging:** the mailbox (one file per message; `send`, `inbox`, `read`; SessionStart
  and `UserPromptSubmit` unread subjects); the native-delivery spike; `register`, the registry and pruning; the
  `Notifier` and its Claude Code implementation.
- **tracks:** `track pr` and `pr.yml`; derived done status, merged-PR reconciliation and
  hygiene warnings in `track list`; `track new` from upstream `main`; `track rm` refusing
  when beads can't be seen; the handoff format change and migration; the offline
  beads-ownership check; the `track` and `handoff` skills (mailbox, self-check, no pointer to
  `docs/workflow.md`).
- **review:** the rule-cases test (its own small first PR); the Markdown reference-parser test; `review-pr`'s look-up
  and Fit section; the self-check text for `track`; the `milestone` and `roadmap` skills.
- **milestone:** the acceptance run that closes it: the acceptance above passes, a release is
  published, and the quick start works from npm.

## Decision points

- **If native delivery into an idle session can't be made reliable,** `messaging` stops
  and brings the spike's findings to the maintainer. The goal and acceptance stay as written
  unless the maintainer amends them; the mailbox and its SessionStart notices ship either way,
  since they don't depend on the spike.
- **Does PRIME.md reach non-Claude agents?** It reaches any agent whose SessionStart hook runs
  `bd prime`. `conventions` confirms how Codex's hook is wired (without `bd setup codex`,
  which writes into AGENTS.md) and reports before relying on it.

## Deferred, with reasons

- Remaining starter rules (`hh2`), agentic layer (`v56`), `mshape validate` (`97o`),
  adoption (`36f`), policy bundles (`8h4`): unchanged from milestone 1, no consumer yet.
- A check that files restating a convention for their reader (the `track` skill's PR size,
  `docs/workflow.md`) still agree with `conventions.ts`: no recurring failure of that kind
  yet, and `track pr` prints the size where it's needed.
- Check messages that say how to fix (`unknown-module`, `readme-lines`, where budgets and
  exempt directories are set): small, and none of them blocks the loop.
- A mailbox address for the maintainer (`to: maintainer`): useful for decisions like `5b4`,
  but the maintainer's sessions aren't tracks yet; revisit once the mailbox has been used.
- A reminder to hand off near the context limit (statusline or PreCompact hook): no failure
  seen yet.
- A private-names check against a denylist kept outside the repo: no leak seen.

## Spend

None: no model calls in this milestone's code.

## Amendments

- **2026-11-03, live notices (#27), approved by the maintainer.** `register` stores the
  session id and Claude Code's pid, not the socket; the socket and peer token are read from
  Claude Code's session record at send time. The socket never replies, so a registration is
  pruned when its session ended, its pid runs another session, or its socket refuses the
  connection. The version check is Claude Code's `peerProtocol`. Reason: the spike
  (`notes/2026-11-03-spike-native-delivery.md`).
- **2026-11-03, the track branch stays in `layout.ts` (#31).** Interfaces says
  `conventions.ts` re-exports the track branch from `layout.ts`; it doesn't, and code imports
  `trackBranch` and `MAIN_BRANCH` from `layout.ts`. Reason: biome's `noBarrelFile`, part of
  this repo's gate and adopters', forbids re-exports.
