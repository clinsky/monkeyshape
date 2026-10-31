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
  promoted, messages nobody answered.
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

Propose one goal, from the human's priorities and the roadmap, with **acceptance on real
data**: a run on a named real target, or a real repo or user doing the thing, never "tests
pass". A new repo's first milestone is "a first result on a real target". Say what you
would defer to make it fit, and why. Iterate until the human agrees; don't write the plan
before that.

## 4. Write plan/MILESTONE.md

First move the old plan to notes/, named with today's date (YYYY-MM-DD-milestone-<n>.md).
Then write the new one, about 500 lines at most:

- **Goal, and how we'll know:** the acceptance agreed above.
- **Where we are:** a gap table, measured where it can be.
- **What changed since the last milestone, and why.**
- **Interfaces the tracks share:** every path, command, format or schema two tracks both
  touch, with its owner and consumer, settled before anyone starts. This is the section
  that keeps parallel work from colliding; spend the effort here.
- **Tracks:** a table of name, charter, beads and acceptance. Split so tracks touch
  disjoint files and meet only at the interfaces. Two to four tracks is typical; one is fine.
- **Decision points**, **spend** for big runs, and **deferred items, each with a reason**.

The plan is frozen once tracks start. Say so at its top.

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

- `mshape track rm <name>` for each finished track. If it refuses, report the reason; never
  reach for `--force` without the human. If the reason is open beads, `--force` won't help,
  and grooming has already decided each one: move it to the track the new plan gives it, or
  close it if it's done, and list what you did in your report. Ask the human only when the
  plan doesn't say.
- `mshape track new <name>` for each new track. Fill its handoff: `Status: active`, the
  charter (its beads, the interfaces it owns or consumes), the state ("not started", and
  how to start), the traps you already know, and messages from the plan.

Finish by telling the human what to launch: for each track, the worktree path and "open a
chat there and run `/track`".

Review this skill after each boundary it runs: what the retrospective found about the
process applies to this file too.
