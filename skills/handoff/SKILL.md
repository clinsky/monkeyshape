---
name: handoff
description: Use when the human says /handoff, or asks to wrap up a track's chat because the context is running out or the session is ending. Rewrites the track's handoff so a fresh chat running /track can continue with nothing else.
---

# Handoff: hand a track to a fresh chat

The next session knows only the repo, the beads and the handoff you write now. Write for an
agent as capable as you who wasn't here: what it needs to continue, not what you did. What a
change did belongs in its PR body and commits, not here.

## 1. Which track

Run `bun run --silent mshape track current` (every `mshape` below runs the same way). If it
exits 1, tell the human its reason and stop: a handoff
belongs to a track.

## 2. Leave nothing only in this chat

- **Uncommitted work:** if no PR is open from the track branch, commit it there, as a WIP
  commit if it isn't finished, and push. If one is open, a push would add it to the PR:
  leave it uncommitted (the next chat opens in this same worktree) and list it in State.
  Never stash: the stash is shared by every worktree.
- **Beads:** close what merged; claim what is half done; file what you found and didn't do.
- **Open PRs:** note each one's number and what it waits on.
- **Mail:** `mshape msg inbox`. Read what you can act on now (`mshape msg read <id>`); what
  you leave unread is shown to the next session when it starts. An answer you owe another
  track goes now, with `mshape msg send`, not into the handoff.

## 3. Rewrite the handoff

Overwrite `.handoffs/<name>.md`; don't append. Keep its format: the title and `Queue:` lines,
then exactly the sections Charter, State (with today's date), Lessons not yet promoted and
Traps, in that order, with `###` for headings inside them. About 120 lines at most.

- **Charter:** leave it unless the work changed what the track is for; then rewrite it, and
  say in State that it changed and why. It opens with `Serves: <goal steps>, because <why>`,
  then `Out of scope:` and `Done means:` lines.
- **State:** done (PRs and beads, by number), in flight (the branch, the PR, what is half
  done and the next command to run), and next. Concrete enough to act on without asking.
- **Lessons not yet promoted:** what you learned that should become a check, a test, an
  AGENTS.md gotcha or a decision. If promoting one is quick, do it now instead and delete
  it here. A lesson that is really a bead becomes one.
- **Traps:** what will bite the next session. Delete traps that are no longer true.

## 4. Check it and hand over

Run `mshape track list`: this track must show `stub` (if the charter isn't agreed yet:
leave it empty, never write one the human hasn't agreed) or `active`, never `invalid`. If it
shows `invalid`, each problem is printed under its row: fix them all and run it again. Then
tell the human, in a few lines: what is done and in flight, anything waiting on their
decision, and "open a fresh chat in this worktree and run `/track`".

Review this skill when a fresh chat had to rediscover something the last one knew.
