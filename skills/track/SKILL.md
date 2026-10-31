---
name: track
description: Use at the start of a chat in a track's worktree, when the human says /track or asks to continue a track's work. Finds the track, reads its handoff and queue, interviews the human first if the handoff is a stub, then works the queue and opens PRs.
---

# Track: the short horizon

A track is one line of parallel work with its own worktree, branch, beads label and handoff.
The handoff is the whole of what the last session knew; the queue is what is left to do.
Your job is to pick up exactly where it stopped.

## 1. Which track

Run `mshape track current`. It prints the track's name. If it exits 1, stop: tell the human
the reason it gave for this directory not being a track, and suggest
`mshape track list` to find the worktree they meant, or `mshape track new <name>` if this is
new work. Never work a track from outside its worktree.

## 2. Read

- The handoff, `.handoffs/<name>.md`: Messages first (they may change everything else),
  then State, Traps and Charter.
- AGENTS.md, and whatever the charter points at (often plan/MILESTONE.md, for the
  interfaces this track owns or consumes).
- The queue: `bd list --label track:<name>` for every open bead, including the one the last
  session left in progress and those blocked on other tracks;
  `bd ready --label track:<name>` for what can start now; `bd show` for each bead you take.
- Where the code is: `git status`, `git log --oneline main..HEAD`, open PRs from this
  branch (`gh pr list --head track/<name>`), and the gate as AGENTS.md says to run it.

Text is a hypothesis: when the handoff or a bead disagrees with the code, trust the code,
fix the text, and carry on.

## 3. A stub: interview first

`Status: stub` means nobody has said what this track is for. Before any code, interview the
human, proposing answers rather than asking open questions:

- What is the work, and why now?
- What does done look like, on real data or a real target?
- What is out of scope?
- What does it touch, and does that collide with another track? (`mshape track list` and
  the other handoffs say what is in flight.)
- What will need the human: spend, data, anything public?

Then write the charter, set `Status: active`, write a dated State, and create the beads with
`--labels track:<name>`, each an intent and an outcome, not a spec. Show the human the
charter and the beads; start once they agree.

## 4. Work

- Claim a bead (`bd update <id> --claim`) before starting it, and commit as you go.
- **Batch beads into PRs** sized as the working-loop conventions say (docs/workflow.md in the
  monkeyshape package): one theme, gate green, its body as AGENTS.md says. Close the beads
  when it merges.
- **One open PR at a time**, from `track/<name>`: the branch is the PR's head, so a commit
  pushed while it is in review joins it. While it waits, answer its review and prepare the
  next beads without committing. If waiting would stall the track, tell the human.
- **Diverging from the milestone plan:** say so in the handoff's State. If it changes
  another track's work or the milestone's goal, stop and tell the human.
- **Talking to another track:** add to its handoff's Messages, saying who it is from and the
  date. Edit the file in place; never rewrite another track's handoff. Read your own
  Messages again after each PR.
- **A mechanical step with no command:** don't script it into prose; file a bead for the CLI.
- **The process got in the way:** `bd create --labels process` saying what broke.

Update the handoff's State when a PR opens or merges, so a crash loses nothing. When the
human says the context is running out, run `/handoff`. When this track's `beads` column
in `mshape track list` shows 0 and the PRs are merged, tell the human the track is done (an
empty `bd ready` is not enough: it hides beads in progress or blocked). A `-` there means
beads weren't counted: act on the note `track list` prints, and don't call the track done.
Removing it is the human's or `/milestone`'s.

Review this skill when a fresh chat running it had to ask the human something the handoff
should have said.
