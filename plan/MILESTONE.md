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
   default, the track branch, the commit's bead reference and git authority each have one
   source in code or in one shipped file. The few copies that restate a value are registered
   and checked against it; nothing else is policed.
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
  configures them, then asserts that their output plus AGENTS.md plus the `track` skill state
  the PR size, how to open a PR, that agents push and open PRs, the decision authority, and
  how to message another track. It must fail on today's `main`.
- **Registered copies agree.** The check passes on this repo and on a born repo, and fails
  when a registered copy's value changes without its owner.
- **Two real Claude Code sessions, in two tracks** (run by hand by the maintainer, recorded in
  the PR): `mshape msg send` from one makes an **idle** recipient show the subject notice with
  no new user prompt; the recipient defers it, keeps working, and later reads it with
  `mshape msg read`; the message stays unread until then. A message to a track with no live
  session, or a stale registration, waits and is shown at the next session's start. The test
  suite covers the same contract with a fake socket; the acceptance is real delivery, not a
  successful write.
- **The tracks use it.** From the moment the mailbox merges, the three tracks message each
  other through `mshape msg`; the maintainer relays nothing the mailbox could have carried.
- **A release is published,** and the README quick start works from npm on a clean machine.

## Non-goals

- **The remaining starter rules, the agentic layer, `mshape validate`** (deferred epics
  `hh2`, `v56`, `97o`): no consumer yet.
- **Adopting an existing repo** (`36f`): after a new repo has been born the new way.
- **Reworking the review process:** rounds, severities and nits are settled in `review-pr`
  and work. This milestone adds the look-up and an author-side self-check, nothing else.
- **Changing the PR size default:** this milestone moves it to where agents see it, not what
  it is.
- **A rendering or templating framework for skills,** and checks that police prose broadly:
  only registered copies of machine-checkable values are checked.
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

## Phase 0: the milestone-1 boundary (before the tracks start)

Done by the maintainer and the planning agent, not a track, in this order:
1. Check whether bd's telemetry (`bd config list`: metrics on, an external endpoint) is
   global and whether born repos inherit it. Anything that leaves the machine is the
   maintainer's call; settle it before a release ships.
2. Publish 0.2.0 from `main` (the quick start then works), with an unknown command saying
   `unknown command` before the help.
3. Close `31v` and `y0p` (resolved). For each milestone-1 handoff, promote or delete each
   lesson (to AGENTS.md, a check, or the code), then `mshape track rm` all three tracks.
4. Archive milestone 1's plan to `notes/` (done in this PR) and replace it with this one.
5. Cut `docs/roadmap.md` back to direction: keep the status table, scope, principles and
   goals; move anything still unique about shipped conventions to where it now lives;
   delete the rest.

## Interfaces the tracks share

Settled before the tracks start. A change goes to the other tracks by `mshape msg` (once it
exists) and to the maintainer.

- **Ownership of code and files,** so no two tracks edit the same file:
  - `coordination`: every `mshape track *` command (`track pr` included) and
    `src/{core,adapters}/tracks.ts`, `mshape msg`, `src/core/handoff.ts`, and the `track` and
    `handoff` skills.
  - `conventions`: `src/core/conventions.ts`, `mshape sync`, `init`, the template, PRIME.md,
    the PR template, `docs/workflow.md`, README, AGENTS.md.
  - `review`: the `review-pr`, `milestone` and `roadmap` skills, and the rule-cases and
    Markdown reference tests.
  - `src/cli/main.ts`: each track adds only its own commands' entries; the help text is
    generated from the command table, so additions don't collide.
  - A track that needs a change in another's file sends it as a message or a bead.
- **`src/core/conventions.ts` owns the machine-checkable values:** `PR_SECTIONS` (name,
  purpose, required), the PR size default, the bead reference in commit messages (a
  `Bead: <id>` trailer, one per bead the commit works on), and the track branch (re-exported
  from `layout.ts`). A value lives here only if code or a check reads it.
- **Registered copies, not rendering.** A short list in `conventions.ts` names each file that
  states one of these values for its reader (for example, the `track` skill states the PR
  size; `docs/workflow.md` explains it to a human). A check verifies that each registered copy
  contains the owner's value. Docs word the convention for their reader; nothing renders
  skills, and nothing flags unregistered prose.
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
  `mshape track pr` (owned by `coordination`) pushes `track/<name>` and creates the track's PR
  from that skeleton, or updates it **without overwriting** the agent's narrative and
  evidence: it fills only machine-known fields, each from a verified fact (the gate's output
  from a run it just did, changed lines from `git diff`, beads from commit trailers). A CI step
  checks the body's required headings, and the `track/*` head branch, only on PRs opened by
  `mshape track pr` (marked in the body); other PRs, like this one, are unaffected.
- **The mailbox is the durable source of truth.** One file per message,
  `<common>/monkeyshape/mail/<track>/<id>.json`, under git's directory so `git clean` can't
  delete it, and written atomically so concurrent senders can't lose messages. A message has
  `id`, `from`, `to`, `subject`, `body` and `created`; reading it moves it to `read/` (atomic
  rename). Reading is consumption by the **track**: once any of its sessions reads a message,
  it is read for all of them. Only `mshape msg read <id>` marks a message read. Commands:
  `mshape msg send <track> --subject <subject> [body]`, `mshape msg inbox`,
  `mshape msg read <id>`. Handoff Messages sections are retired.
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
  - **Replaceable transport:** notices go through a `Notifier` service; the Claude Code socket
    is its one implementation now, behind a check of the session registry's protocol version.
- **Handoff format:** the `Status` line is removed (a stub is a handoff with an empty
  charter; "done" is derived by `track list`), and so is `Messages`; existing handoffs are
  migrated when the parser changes. The Charter opens with
  `Serves: goal step <n>, because ...`, then `Out of scope:` and `Done means:`; `/milestone`
  writes them from this plan's track table.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `conventions` | goals 1, 2 | Kept small, so nobody waits on it. `conventions.ts`, registered copies and their check; PRIME.md, `mshape sync` and its checks (shipped copy, hook present, budget); the PR template and the skeleton function; how hooks and skills invoke `mshape`; a born repo ready for the first chat (`init` prints the `gh repo create --source . --push` step, sets `agent.profile`, and its `package.json` doesn't record a machine-specific tarball path); the AGENTS.md split, with a dogfooding section in this repo's; the fresh-agent test; refs scans `plan/` and `notes/`, and the new-repo refs test builds its fixture from `template/` | The fresh-agent test and the registered-copies check pass, and fail on today's `main` |
| `coordination` | goals 3, 4 | The mailbox first (`send`, `inbox`, `read`, the SessionStart hook showing unread subjects), so the tracks use it early; then a spike that proves native socket delivery into a real idle session and reports; then `register`, the session registry, stale pruning and the `Notifier` with its Claude Code implementation. Every `track *` command: `track pr`; `track list`'s derived done status and handoff hygiene warnings; `track new` from upstream `main`; `track rm` refuses when `.beads/` exists, beads is `optional` and `bd` isn't installed. The handoff format change and migration. A beads-ownership check: open beads with a `Bead:` trailer on `main`, open beads with no `track:` label, deferred beads with one, `TODO(<id>)` on closed beads. The `track` and `handoff` skills | The two-session acceptance above, including the idle recipient; a message to a track with no live session waits and is shown at its next session; `track list` shows finished tracks as done |
| `review` | goal 5 | First, the test that every rule has must-pass and must-fail cases, and the Markdown reference-parser test, before any track adds a check. `review-pr` reads the milestone (why, non-goals, the track's row), the track's charter and the PR's beads before the diff; every review body has a short "Fit" section: does it serve its beads and goal step, is anything outside them (filed as a bead, as nits already are), is it redundant with existing code or docs, is there prose where a check belongs. The author self-check text for the `track` skill (re-run the reviewer's probes before replying "fixed", try to break the fix with valid input), handed to `coordination`, which owns that file. The `milestone` and `roadmap` skills write the plan sections this plan uses (why, non-goals, how tracks serve, amendments) | The rule-cases test fails when a rule loses its must-pass case; a plan written by `/milestone` has every section above; a manual review of a deliberately out-of-scope PR flags it under "Fit" |

**Order:** `review`'s rule-cases test lands before any track adds a check; `coordination`'s
mailbox lands before its socket work; `conventions.ts` lands in `conventions`' first PR.
Nothing else waits on another track.

## Proposed beads (filed after approval)

- **conventions:** `conventions.ts` and registered copies with their check; PRIME.md,
  `mshape sync` (with `skills sync` as its alias) and its checks; how hooks and skills invoke
  `mshape`, tested from a born repo and a worktree; the PR template and skeleton function;
  `init` for the first chat (the `gh repo create` step, `agent.profile`, no machine-specific
  tarball path); the AGENTS.md split and the dogfooding section; the fresh-agent test; refs
  covering `plan/` and `notes/`, and the new-repo refs test built from `template/`.
- **coordination:** the mailbox (one file per message; `send`, `inbox`, `read`; SessionStart
  unread subjects); the native-delivery spike; `register`, the registry and pruning; the
  `Notifier` and its Claude Code implementation; `track pr` and the CI body check; derived
  done status and hygiene warnings; `track new` from upstream `main`; `track rm` in the
  `optional` without `bd` case; the handoff format change and migration; the beads-ownership
  check; the `track` and `handoff` skills.
- **review:** the rule-cases test; the Markdown reference-parser test; `review-pr`'s look-up
  and Fit section; the self-check text for `track`; the `milestone` and `roadmap` skills.
- **milestone:** the acceptance run that closes it: the acceptance above passes, a release is
  published, and the quick start works from npm.

## Decision points

- **If native delivery into an idle session can't be made reliable,** `coordination` stops
  and brings the spike's findings to the maintainer. The goal and acceptance stay as written
  unless the maintainer amends them; the mailbox and its SessionStart notices ship either way,
  since they don't depend on the spike.
- **Does PRIME.md reach non-Claude agents?** It reaches any agent whose SessionStart hook runs
  `bd prime`. `conventions` confirms how Codex's hook is wired (without `bd setup codex`,
  which writes into AGENTS.md) and reports before relying on it.

## Deferred, with reasons

- Remaining starter rules (`hh2`), agentic layer (`v56`), `mshape validate` (`97o`),
  adoption (`36f`), policy bundles (`8h4`): unchanged from milestone 1, no consumer yet.
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

None yet.
