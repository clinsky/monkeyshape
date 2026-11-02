# Milestone 2: conventions as code

**Draft for review, 2026-11-02.** Reviewed by the three milestone-1 tracks, then approved by
the maintainer; beads are filed only after approval. Once approved, the plan is frozen for the
milestone, except that a divergence the maintainer approves is appended under "Amendments"
with its date and reason, so the plan never goes stale.

## Why this milestone

monkeyshape exists because prose is fragile: it works only if it is loaded and noticed, it
goes stale, and docs that restate docs spread their errors. Its answer is mechanism over
prose, one home per fact, and a budget for what is loaded automatically (docs/roadmap.md,
Principles).

Milestone 1 applied that answer to **code** and shipped the working loop. But it shipped the
loop's **conventions** as prose, and they decayed in exactly the ways the thesis predicts.
Six read-only audits of the repo and of a freshly initialized one found:

- **No owner, many copies.** The PR body's sections exist in five versions; the three tracks
  wrote three dialects, and the `milestone` skill's retrospective reads PR bodies by section
  name. Decision authority exists in five versions, and a skill cites a spend cap defined
  nowhere. The roadmap's sections 2 to 9 restate conventions that have since moved and
  drifted.
- **The wrong moment.** A new repo loads none of the conventions; only `/roadmap` is named in
  anything it loads. The `track` skill sends agents to `docs/workflow.md`, which isn't in a
  born repo, for the PR size. The `bd prime` hook, the largest text loaded every session,
  tells agents not to push, contradicting AGENTS.md.
- **State recorded by hand.** Cross-track messages were pull-only and arrived only when the
  maintainer relayed them. Handoffs only grew: finished tracks still say `Status: active`,
  answered messages and stale traps remain. Beads stayed open after their decision shipped,
  and a mislabelled bug made a track look done.
- **Review looked down, not up.** Reviews caught real bugs on nearly every PR, but nothing asks
  a reviewer to read the milestone, the track's charter or the bead, so no review asked
  whether a change fit the milestone's intent or duplicated something.

This milestone applies monkeyshape's thesis to its own conventions. It comes before the
first real adoption (`iqf.14`, a new repo born through the loop): that run should test the
loop, not trip over contradictions we already know about.

## Goal, and how we'll know

1. **One owner per convention.** Every convention an agent acts on (PR body sections, PR size,
   branch per track, soft caps, default decision authority, git authority) has one source in
   code or in one shipped file. Every other copy is generated from it or checked against it.
2. **Delivered at the moment of need.** What every session needs arrives at session start for
   any agent; what one step needs is in that step's skill or printed by the command used then.
   No skill sends an agent to another doc for a rule.
3. **Messages are delivered, not hoped for.** A message to another track reaches its live
   session as a notice with the subject at the next tool call or prompt, and waits for the
   next session if none is running.
4. **Status is derived, not remembered.** Whether a track is done, whether a bead's work has
   merged, whether a handoff is stale: computed from git, PRs and beads, and flagged.
5. **Review looks up.** A reviewer reads the milestone's why and non-goals, the track's
   charter and the PR's beads before the diff, and says in the review whether the PR fits
   them.

**Acceptance on real data:**
- A test assembles exactly what a fresh agent in a new track of a born repo has loaded (the
  `bd prime` hook output, AGENTS.md, the `track` skill) and asserts it states the PR size, the
  PR body source, that agents push and open PRs, the decision authority, and how to message
  another track. It must fail on today's `main`.
- A duplicate-fact test passes on this repo and on a born repo, and fails when a convention
  is restated somewhere that isn't a registered copy.
- During this milestone, the three tracks message each other through `mshape msg` from the
  moment it merges; the maintainer relays nothing that the mailbox could have carried.
- A release is published, and the README quick start works from npm on a clean machine.

## Non-goals

- **The remaining starter rules, the agentic layer, `mshape validate`** (deferred epics
  `hh2`, `v56`, `97o`): no consumer yet.
- **Adopting an existing repo** (`36f`): after a new repo has been born the new way.
- **Reworking the review process:** rounds, severities and nits are settled in `review-pr`
  and work. This milestone adds the look-up and an author-side self-check, nothing else.
- **Changing the PR size default** (1k to 2.5k changed lines, as `docs/workflow.md` says):
  this milestone moves it to where agents see it, not what it is.
- **A socket transport that relies on Claude Code internals** as the only delivery path (see
  "Decision points").

## Where we are

| Area | Today |
|---|---|
| PR body | 5 section lists (roadmap, workflow.md, AGENTS.md, template PR template, review-pr's names); no PR template in this repo; `gh pr create --body-file` bypasses GitHub's template anyway |
| Session-start context | `bd prime` default text (about 6.5 KB, unbudgeted) contradicts AGENTS.md on pushing, bead-first, markdown tracking and when to close beads |
| A born repo | loads AGENTS.md (no loop, no PR rules) and the contradicting hook; `mshape` isn't on PATH for the skills; no remote, so the first `/roadmap` can't push |
| Messages | appended to other tracks' handoffs; pull-only; direction varies (some outbound notes sit in the sender's own file) |
| Status | handoff `Status` set by hand and stale; beads closed by hand; `track list` shows merged and bead counts but not "done" |
| Review | `review-pr` reads AGENTS.md and the diff, not the milestone, charter or bead |
| npm | 0.1.0, without `init`; the README quick start fails |

## What changed since milestone 1, and why

- One open PR per track, from `track/<name>` (`5b4`); PR size is a batching default, not a
  gate; nits stay open until settled; rounds are uncapped. These held and stay as they are.
- Settled during milestone 1 and now in code: open beads block `track rm`; merged is judged
  against upstream `main`; `bd init`'s commit is folded into `init`'s first commit (`31v`);
  launching a track takes `mshape track new` and `/track` (`y0p`).

## Phase 0: the milestone-1 boundary (before the tracks start)

Done by the maintainer and the planning agent, not a track:
1. Publish 0.2.0 from `main` (the quick start then works), and make an unknown command say
   `unknown command` before the help.
2. Close `31v` and `y0p` (resolved). Set the three handoffs' status, promote or delete each
   lesson (to AGENTS.md, a check, or the code), then `mshape track rm` all three tracks.
3. Archive milestone 1's plan to `notes/` (done in this PR) and replace it with this one.
4. Verify whether bd's telemetry (`bd config list`: metrics on, external endpoint) is global
   and whether born repos inherit it; anything that leaves the machine is the maintainer's
   call.

## Interfaces the tracks share

Settled before the tracks start; a change goes to the other tracks by `mshape msg` (once it
exists) and to the maintainer.

- **`src/core/conventions.ts` owns every convention value** an agent acts on: `PR_SECTIONS`
  (name, purpose, required), `PR_SIZE` (the default range and its wording), `TRACK_BRANCH`
  (re-exported from `layout.ts`), the soft caps (handoff lines, plan lines, bead characters,
  hand-off point), and the default decision authority. Owner: `conventions`.
- **Rendering:** skills and templates refer to a value as `{{conventions.<key>}}`;
  `mshape sync` and `init` render them from `conventions.ts`. A check fails if a rendered file is out
  of date or a value is written out literally where a placeholder belongs. Owner:
  `conventions`; every track uses placeholders instead of numbers.
- **`.beads/PRIME.md` is monkeyshape's always-loaded conventions file** (about 60 lines,
  budgeted). bd's SessionStart hook stays; PRIME.md replaces its default text, so the hook
  agrees with AGENTS.md (bd still appends memories). `init` writes it and sets
  `agent.profile team-maintainer` as a fallback; `mshape sync` keeps it current; a check
  requires it to match the shipped copy and the hook to exist. AGENTS.md stays repo-owned
  and carries one pointer line. Owner: `conventions`.
- **The PR body:** `.github/pull_request_template.md` is generated from `PR_SECTIONS` in this
  repo and in born repos. `mshape track pr` pushes `track/<name>` and creates or updates the
  track's PR with that skeleton, filling what a machine knows (gate output, changed lines,
  the beads in its commits). A CI step on pull requests checks the body's headings and that
  the head branch is `track/*`. Skills say `mshape track pr`, not section lists. Owner:
  `conventions`.
- **The mailbox:** messages live in git's directory beside the handoffs,
  `<common>/monkeyshape/mail/<track>.jsonl`, so `git clean` can't delete them. Each message
  has `id`, `from`, `to`, `subject`, `body`, `created` and `read`. Commands:
  `mshape msg send <track> --subject <subject> [body]`, `mshape msg inbox`,
  `mshape msg read <id>`. A hook command, `mshape msg notify`, runs on SessionStart,
  UserPromptSubmit and PostToolUse; it costs one file check when nothing is new, and injects
  only `you have mail: <subject> (mshape msg read <id>)`, never the body, once per message. Handoff Messages sections are retired.
  Owner: `coordination`.
- **Handoff format additions:** the Charter opens with `Serves: goal step <n>, because ...`,
  then `Out of scope:` and `Done means:`; `/milestone` writes them from this plan's track
  table. `Status` is derived by `track list`, and the parser warns when a written status
  disagrees. Owner: `coordination` (`src/core/handoff.ts`); `review` writes the milestone
  skill's side.
- **Skill ownership,** so no two tracks edit the same file: `track`, `handoff` →
  `coordination`; `review-pr`, `milestone`, `roadmap` → `review`; PRIME.md, the templates,
  `docs/workflow.md`, README, AGENTS.md → `conventions`. A track that needs a change in
  another's file sends it as a message or a bead.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `conventions` | goal 1, 2 | `conventions.ts` and placeholder rendering; PRIME.md with `mshape sync` and its checks; generated PR template, `mshape track pr` and the CI body check; the born repo works from the first chat (an `mshape` script, `init`'s next steps covering the remote and `gh`); the AGENTS.md split, with the dogfooding section in this repo's; the duplicate-fact test; the roadmap cut back to direction | The "what a fresh agent loaded" test and the duplicate-fact test pass, and fail on today's `main` |
| `coordination` | goal 3, 4 | `mshape msg` and its hooks in the template and this repo; the handoff format additions and derived status; a beads-ownership check (merged but open, open with no `track:` label, deferred but labelled, `TODO(id)` on a closed bead); `track new` from upstream `main`; `track rm` refuses when beads couldn't be counted; handoff hygiene warnings in `track list`; the `track` and `handoff` skills | A message between two live sessions arrives as a notice within one tool call; one sent to a track with no session waits and is shown at its next session; `track list` shows done tracks as done |
| `review` | goal 5 | `review-pr` reads the milestone (why, non-goals, the track's row), the track's charter and the PR's beads before the diff, and every review body has a short "Fit" section: does it serve its beads and goal step, anything outside them (filed as a bead, as nits already are), redundant with existing code or docs, prose where a check belongs; the `track` skill gains an author self-check before replying "fixed" (re-run the reviewer's probes, try to break the fix with valid input), sent to `coordination` as a change to their file; the `milestone` and `roadmap` skills write the plan sections this plan uses (why, non-goals, how tracks serve, amendments); a test that every rule has must-pass and must-fail cases; a reference-parser test for the checks that read Markdown | A review of a deliberately out-of-scope test PR flags it in "Fit"; a plan written by `/milestone` has every section above; the rule-cases test fails when a rule loses its must-pass case |

`conventions` lands `conventions.ts` and the placeholder rendering first: the other tracks
write against placeholders from day one. `coordination` lands `mshape msg` early, so the
tracks use it for the rest of the milestone.

## Proposed beads (filed after approval)

- **conventions:** conventions.ts and placeholder rendering; PRIME.md, `mshape sync`, and its
  checks (shipped copy, hook present, budget); `init` sets `agent.profile`; generated PR
  template and `mshape track pr`; CI PR-body check; born repo ready for the first chat
  (`mshape` script, next steps for the remote and `gh`, `--from` without an absolute path);
  the AGENTS.md split and the dogfooding section; duplicate-fact test; the
  what-a-fresh-agent-loaded test; roadmap cut to direction; check messages that say how to
  fix (`unknown-module`, `readme-lines`, where budgets and exempt directories are set).
- **coordination:** `mshape msg` (send, inbox, read) and its storage; `mshape msg notify`
  hooks; handoff format additions and derived status; beads-ownership check; `track new`
  from upstream `main`; `track rm` when beads couldn't be counted; handoff hygiene warnings;
  `track` and `handoff` skills updated (mailbox, self-check text from `review`).
- **review:** `review-pr` look-up and the Fit section; the self-check text for the `track`
  skill; `milestone` and `roadmap` skills write the new plan sections; rule-cases test;
  Markdown reference-parser test.
- **milestone:** the acceptance run (closes the milestone): the three acceptance tests pass,
  a release is published, and the quick start works from npm.

## Decision points

- **Live delivery.** The mailbox plus documented hooks is the delivery path: it reaches a
  busy session at its next tool call, any session at its next prompt, and a new session at
  start, and non-Claude agents read the same mailbox. Claude Code's own cross-session
  messaging can wake an idle session, but an external command can only reach it through an
  undocumented socket format. Proposal: `coordination` builds the mailbox and hooks; waking
  an idle session through the socket is a follow-up behind a protocol-version check, decided
  by the maintainer once the mailbox has been used for a while.
- **Can PRIME.md carry the conventions for non-Claude agents?** It reaches any agent whose
  SessionStart hook runs `bd prime`. `conventions` confirms how Codex's hook is wired (without
  `bd setup codex`, which writes into AGENTS.md) and reports before relying on it.
- **Who reviews the plan's amendments** during the milestone: the maintainer approves; the
  amending track appends the entry in its PR.

## Deferred, with reasons

- Remaining starter rules (`hh2`), agentic layer (`v56`), `mshape validate` (`97o`),
  adoption (`36f`), policy bundles (`8h4`): unchanged from milestone 1, no consumer yet.
- A reminder to hand off near the context limit (statusline or PreCompact hook): no failure
  seen yet.
- A private-names check against a denylist kept outside the repo: no leak seen; cheap to
  add when wanted.

## Spend

None: no model calls in this milestone's code.

## Amendments

None yet.
