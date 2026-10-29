---
name: handoff
description: Use when the human says /handoff, or asks to wrap up a track's chat because the context is running out or the session is ending. Rewrites the track's handoff so a fresh chat running /track can continue with nothing else.
---

# Handoff: hand a track to a fresh chat

The next session knows only the repo, the beads and the handoff you write now. Write for an
agent as capable as you who wasn't here: what it needs to continue, not what you did. What a
change did belongs in its PR body and commits, not here.

## 1. Which track

Run `mshape track current`. If it exits 1, tell the human its reason and stop: a handoff
belongs to a track.

## 2. Leave nothing only in this chat

- **Uncommitted work:** commit it to the track branch, as a WIP commit if it isn't finished,
  and push. Never stash: the stash is shared by every worktree.
- **Beads:** close what merged; claim what is half done; file what you found and didn't do.
- **Open PRs:** note each one's number and what it waits on.

## 3. Rewrite the handoff

Overwrite `.handoffs/<name>.md`; don't append. Keep its format: the title, `Status:` and
`Queue:` lines, then exactly the sections Charter, State (with today's date), Lessons not
yet promoted, Traps, Messages, in that order, with `###` for headings inside them. About 120
lines at most.

- **Charter:** leave it unless the work changed what the track is for; then rewrite it, and
  say in State that it changed and why.
- **State:** done (PRs and beads, by number), in flight (the branch, the PR, what is half
  done and the next command to run), and next. Concrete enough to act on without asking.
- **Lessons not yet promoted:** what you learned that should become a check, a test, an
  AGENTS.md gotcha or a decision. If promoting one is quick, do it now instead and delete
  it here. A lesson that is really a bead becomes one.
- **Traps:** what will bite the next session. Delete traps that are no longer true.
- **Messages:** delete the answered ones and keep the open ones. Your messages to other
  tracks go in their handoffs, not here.

## 4. Check it and hand over

Run `mshape track list`: this track must show `active`, not `invalid`. If it is invalid,
fix the problem it names. Then tell the human, in a few lines: what is done and in flight,
any messages they need to relay to another track or decide on, and "open a fresh chat in
this worktree and run `/track`".

Review this skill when a fresh chat had to rediscover something the last one knew.
