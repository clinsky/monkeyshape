---
name: roadmap
description: Use when the human brings a brain-dump about where the repo is heading (new goals, a change of direction, a fresh repo after mshape init), or asks to rewrite the roadmap. Interviews until the goals are clear, writes docs/roadmap.md with a status table first, keeps one deferred beads epic per goal, and opens a PR.
---

# Roadmap: the long horizon

The roadmap is direction, not a spec: months ahead, coarse, rewritten in place, never cited
by code or normative docs. Your job is to turn a brain-dump into goals clear enough that a
later `/milestone` can pick one and give it acceptance on real data.

Run this in the main checkout, on an up-to-date `main`, in a fresh chat.

## 1. Read what exists

- docs/roadmap.md, if there is one, and AGENTS.md.
- The direction epics: `bd list --type epic --all`. Deferred ones are goals not yet pulled
  into a milestone; open ones are in flight; closed ones shipped.
- If a milestone is running, plan/MILESTONE.md, only to know what is already committed.

## 2. Interview

Ask in small batches, and propose answers rather than asking open questions: "I read this as
X; is that right?" is cheaper for the human than "what do you mean?". Keep going until you
could write, for every goal:

- **The consumer:** who or what uses it first. No goal without one.
- **What done looks like** on real data or a real target, not a feature list.
- **Why now, or why later**, and what it depends on.
- **What is out of scope**, said out loud, so the next agent doesn't build it.
- **Spend or authority** it will need from the human (money, public releases, data).

Push back where the brain-dump conflicts with the code, with the repo's principles in
AGENTS.md, or with itself. The human owns priorities; you own pointing out that two of them
collide. Stop interviewing when another question would not change what you write.

## 3. Write docs/roadmap.md

Rewrite it in place; git has the history, so keep no revision log and no frozen copy.

- **Open with a status table**: one row per goal, with status `Shipped`, `Milestone N` (in
  progress), `Later` or `Idea`, and the epic id. A reader learns what exists without reading
  the design.
- Then scope (who it's for, what it is not), then a section per goal: the intent, the
  consumer, what done looks like, and what was learned so far. Far-off detail belongs here,
  not in beads.
- No dated promises, no restating AGENTS.md or DECISIONS.md, and nothing other docs would
  need to cite: if something must be enforced, it becomes a check, a test or a decision.

## 4. One deferred epic per goal

For each goal without an epic: `bd create --type epic --title "<goal>" --description "..."`
with the goal, two or three lines of why, and the roadmap section it comes from, then
`bd defer <id>`. **No child stories:** a milestone creates those when it pulls the epic in.
For goals that changed, rewrite the epic; for goals dropped, close it with the reason. Put
each epic's id in the status table.

## 5. PR

Branch from `main`, commit, push, and open a PR whose body says what changed in the
direction and why, which epics were created, rewritten or closed, and what the interview
left open. Gate green first (`bun run check`). The human merges.

Then tell the human the next step: `/milestone` in a fresh chat, with their priorities.

Review this skill when a roadmap written with it was hard for `/milestone` to plan from.
