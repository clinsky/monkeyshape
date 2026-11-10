---
name: milestone
description: Use at a milestone boundary, when the human brings priorities for the next stretch of work, or when the repo has a roadmap but no milestone plan yet. Runs the retrospective, agrees a goal with acceptance on real data, writes plan/MILESTONE.md, grooms beads and the roadmap, gardens, and creates the tracks with mshape track.
---

# Milestone: the mid horizon and the boundary

A milestone is the next significant delivery: several PRs from each of several parallel
tracks. The boundary is the repo's only ceremony, and this skill runs all of it, in order.
The human owns priorities and approves the plan; you bring the evidence and the proposal.

Run this in the main checkout, on an up-to-date `main`, in a fresh chat.

## 1. Gather

- plan/MILESTONE.md (the milestone ending), docs/roadmap.md, AGENTS.md.
- `mshape track list`, and every track's handoff in `.handoffs`: state, lessons not yet
  promoted. If list notes a handoff in an older format, run `mshape track migrate` first,
  so you read it as the tracks will. Then every track's unread mail, in one step: `mshape msg inbox --all`, from
  here. A message still unread at the boundary is a question nobody answered.
- The milestone's epic and its children (`bd list --parent <epic> --all`), and
  `bd list --label process` for what got in the way.
- Merged PRs since the plan was written (`gh pr list --state merged`), and their bodies'
  "not done" sections.
- `mshape garden`.

On a repo's first milestone there is nothing to look back on: skip to step 3.

## 2. Retrospective

Tell the human, briefly: what shipped against each acceptance line, what slipped and why,
what the process beads and handoff lessons say, and what you would change. Facts with
links (PRs, beads), not a story. Ask what they saw that you didn't.

## 3. Agree the goal

Propose one goal, from the human's priorities and the roadmap: by default the roadmap's
next goal not yet shipped, in its listed order, whose "why it comes when it does" line seeds
the plan's "Why this milestone". Give it **acceptance on real data**: a run on a named
real target, or a real repo or user doing the thing, never "tests pass". A new repo's first
milestone is "a first result on a real target". Say what you would defer to make it fit,
and why. Iterate until the human agrees; don't write the plan
before that.

## 4. Write plan/MILESTONE.md

First move the old plan to notes/, named with today's date (YYYY-MM-DD-milestone-<n>.md).
Then write the new one, about 500 lines at most, with these sections in this order. A track's
charter, a reviewer's "Fit" and the next retrospective all read them, so none is optional:

- At the top, under the title: the date, and that the plan is frozen once tracks start,
  except through Amendments.
- **Why this milestone:** the problem, with the evidence (PRs, beads, retrospective
  findings), and why it comes now rather than another roadmap goal.
- **Goal, and how we'll know:** the goal as numbered steps, so tracks and beads can cite
  "goal 2"; then the acceptance agreed above.
- **Non-goals:** what this milestone will not do, each with its reason (no consumer yet,
  depends on something later, settled already). A reviewer flags a PR that builds one.
- **Where we are:** a gap table, measured where it can be.
- **What changed since the last milestone, and why.**
- **Interfaces the tracks share:** every path, command, format or schema two tracks both
  touch, with its owner and consumer, settled before anyone starts. This is the section
  that keeps parallel work from colliding; spend the effort here.
  - **A case table for each lifecycle or workflow fact** the plan introduces or changes: a
    state something is in, derived from other facts (a track is done, a session's address,
    a check's outcome). One sentence defining it hides its edge cases, and each one costs a
    review round. Write a table of `| Case | Result |`: the ordinary cases, then the ones
    a reviewer would try (a reused name, something just made, a half-finished step, nothing
    to go on, an ambiguous match). The owning track turns the table into its test first,
    one test per row. The table is a floor: a case found in review joins the test as a row.
    A plain value (a path, a size limit, a flag's name) needs no table.
- **Tracks:** a table of name, **Serves** (the goal steps it serves), charter, beads and
  acceptance. Each track serves at least one step, and every step is served by a track; a
  track that serves none is out of scope. Split into as many parallel
  tracks as the work allows: each touches disjoint files and meets the others only at the
  interfaces. Derive the number from the work, not a habit: up to about five is usual, and
  one is fine when the work is sequential. When a track ends up holding far more than the
  others, or the riskiest work alongside everything else, split it.
- **Decision points**, **spend** for big runs, and **deferred items, each with a reason**.
- **Amendments:** empty at first ("None yet."). Once tracks start, a divergence the human
  approves is appended here with its date, what changed and why; the sections above are
  not edited. A track that diverges sends it to `main` with `mshape msg send main`; its
  handoff is read by no one else.

## 5. Groom

- Create the milestone epic, and its stories as children labelled `track:<name>`, with
  dependencies (`bd dep add`). An interface gets its own bead, owned by one track. A bead
  is intent and an outcome as acceptance, about 1,500 characters at most, not a spec.
- Pull roadmap epics in with `bd undefer`; close epics whose work is done.
- Close, defer or rewrite every open story the milestone doesn't need, with a reason. A
  story deferred out of the milestone drops its `track:` label.
- P1 is the critical path only.
- Re-verify each bd memory (`bd memories`) against the code; rewrite or delete stale ones.
- Every `TODO(<bead id>)` in code whose bead is now closed: fix it or re-point it.

## 6. Garden

Act on `mshape garden`: anything over budget or grown since the last boundary gets pruned,
not waived. Promote each handoff lesson to a check, a test, an AGENTS.md gotcha or a
decision, or delete it. Try to turn each prose rule into a check, and each review finding
that recurred into one. A process bead whose fix is general belongs upstream in monkeyshape:
tell the human; filing outside the repo is theirs to approve.

## 7. Roadmap and PR

Update docs/roadmap.md: the status table, and what this milestone taught. Then one PR with
the plan, the roadmap and the garden changes, gate green, the body saying what was decided
and why. The human merges.

## 8. Tracks

Once the PR is merged (or the human says to start):

- `mshape msg inbox --all` again, first: `rm` refuses a track with unread mail, and
  `--force` deletes the mail unread. For each track you will remove that still has some,
  read it from that track's worktree (`mshape msg read <id>` there marks it read). Anything
  the new plan doesn't already answer becomes a bead or a message to the track that now
  owns it. Drop mail unread only with the human's yes. A mailbox whose track is gone is
  flagged: read its messages, one JSON file each in the directory the note names, and treat
  them like the rest; delete that directory only with the human's yes.
- `mshape track rm <name>` for each track whose `done` column in `mshape track list` says
  `yes`, and for no other. `unknown` means `bd` or `gh` couldn't say: act on the note
  `track list` prints, then list again; never remove on it. `no` on a track the new plan
  doesn't continue: an open bead is grooming's, already decided, so move it to the track
  the plan gives it or close it if it's done, and list what you did in your report; ask the
  human only when the plan doesn't say; then list again. An open PR, unmerged commits, or
  no merged PR since the track started are always the human's to decide: `rm` doesn't
  refuse on the first or the last. If `rm` refuses, report the reason; never reach for
  `--force` without the human.
- A track the new plan continues under the same name shows `done` `no`, because grooming
  already labelled its new beads. When every open bead with its label is one the plan gives
  that track (any other is grooming's, as above), retire it with
  `mshape track rm <name> --keep-beads`, then start it again with `mshape track new <name>`.
  `--keep-beads` checks the rest of `done` itself and names each fact that fails, and
  `--force` doesn't override it. If it refuses only because `gh` couldn't be read, get `gh`
  working and retry once; if the same refusal comes back, or on any other refusal, the
  track is the human's, as above. It leaves those beads labelled for the new track, and
  lists them.
- `mshape track new <name>` for each new track. Fill its handoff (`.handoffs/<name>.md`):
  the charter, the state ("not started", and how to start) with today's date in its
  heading, and the traps you already know. Change nothing else: there is no status line
  (a handoff with an empty charter is a stub, and one with a charter is active), and no
  Messages section. The charter opens with three lines, in this order, each free to wrap:
  `Serves:` the goal steps from the plan's track table, then `because` and why this track
  now; `Out of scope:` the non-goals nearest this track; `Done means:` its acceptance. Then,
  freely, its beads and the interfaces it owns or consumes. For example:

  ```markdown
  ## Charter

  Serves: goal 2, because the second consumer needs the export before it can start.
  Out of scope: the import side (milestone non-goal); any format change (owned by `api`).
  Done means: an export of the named real dataset round-trips through the consumer.

  Beads (epic `x-1`): `x-1.3` the export command, `x-1.4` its schema test.
  You own: `src/export/`. You consume: the record schema from `api`.

  ## State (2026-01-15)

  Not started. Begin with `x-1.3`; `api` lands the schema first.
  ```

  What the plan says one track must tell another goes by mail, not into a handoff:
  `mshape msg send <name> --subject "<one line>" "<body>"`, run from the main checkout, so
  it arrives from `main` and the answer comes back to `main`'s mailbox.

Finish by telling the human what to launch: for each track, the worktree path and "open a
chat there and run `/track`".

Review this skill after each boundary it runs: what the retrospective found about the
process applies to this file too.
