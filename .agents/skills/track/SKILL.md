---
name: track
description: Use at the start of a chat in a track's worktree, when the human says /track or asks to continue a track's work. Finds the track, reads its handoff and queue, interviews the human first if the handoff is a stub, then works the queue and opens PRs.
---

# Track: the short horizon

A track is one line of parallel work with its own worktree, branch, beads label and handoff.
The handoff is the whole of what the last session knew; the queue is what is left to do.
Your job is to pick up exactly where it stopped.

## 1. Which track

Run `bun run --silent mshape track current` (every `mshape` below runs the same way). It
prints the track's name. If it says the worktree is on a detached HEAD, check out
`track/<name>` there and carry on. If it exits 1 for any other reason, stop: tell the human
the reason it gave for this directory not being a track, and suggest `mshape track list` to
find the worktree they meant, or `mshape track new <name>` if this is new work. Never work a
track from outside its worktree.

Then bring the branch up to date: `git fetch`, and `git merge --ff-only origin/main` when
`git log --oneline origin/main..HEAD` is empty (a plain merge otherwise). The hooks that show
your mail come with `main`; if this session started before they were there, run
`mshape msg register` once so live notices reach it.

## 2. Read

- Your mail first, since it may change everything else: `mshape msg inbox` lists the
  unread subjects, and `mshape msg read <id>` shows one and marks it read for the track.
  Read each one before you plan.
- The handoff, `.handoffs/<name>.md`: State, Traps, then Charter.
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

An empty Charter means nobody has said what this track is for: the handoff is a stub. Before any code, interview the
human, proposing answers rather than asking open questions:

- What is the work, and why now?
- What does done look like, on real data or a real target?
- What is out of scope?
- What does it touch, and does that collide with another track? (`mshape track list` and
  the other handoffs' charters say what is in flight.)
- What will need the human: spend, data, anything public?

Then write the charter, opening with these three lines (each may wrap; anything after them
is free, such as the beads and what the track owns):

    Serves: <goal steps>, because <why this track, now>.
    Out of scope: <...>
    Done means: <...>

Write a dated State, and create the beads with `--labels track:<name>`, each an intent and an
outcome, not a spec. Show the human the charter and the beads; start once they agree.

## 4. Work

- Claim a bead (`bd update <id> --claim`) before starting it, and commit as you go.
- **Batch beads into PRs** of one theme: many small PRs cost more review than a few large
  ones. Open and refresh the PR with `mshape track pr`: it prints the size against the
  batching default (a default, not a gate), runs the gate fresh and fills the Gate section.
  Write the rest of the body in a file with the sections of .github/pull_request_template.md,
  each bead as a list item starting with its id. The first time, pass both
  `--title "<title>"` and `--body-file <path>`; after that `mshape track pr` alone keeps the
  body as it stands.
  Close the beads when it merges.
- **One open PR at a time**, from `track/<name>`: the branch is the PR's head, so a commit
  pushed while it is in review joins it. While it waits, answer its review and prepare the
  next beads without committing. If waiting would stall the track, tell the human.
- **Answering a review:** "fixed" is a claim the reviewer will test, so test it first.
  - Rerun each of the reviewer's probes on your new head, and quote what it prints now.
  - Try to break your fix with valid input the reviewer didn't try: the mirror case, a
    neighbouring construct, the same input inside a list or a quote. A fix often opens the
    next finding.
  - Give each code blocker a regression test that fails on the old head and passes on the
    new, and name it in your reply.
  - Claim nothing general ("can't fail", "every case") that no test would catch if it were
    false. Say what is covered instead, in the reply and in the PR body.
- **Diverging from the milestone plan:** say so in the handoff's State. If it changes
  another track's work or the milestone's goal, stop and tell the human.
- **Talking to another track:** `mshape msg send <track> --subject "<one line>" "<body>"`.
  The subject is all a notice shows, so make it say what the message is for; put the detail
  in the body. Never edit another track's handoff.
- **Mail arriving:** a live notice, `[mshape] Message from <track>: <subject>`, or a line at
  your next prompt. Neither marks it read. Finish the step you are on if it can wait, then
  `mshape msg read <id>`, and act on it or answer it. Check `mshape msg inbox` after each PR.
- **A mechanical step with no command:** don't script it into prose; file a bead for the CLI.
- **The process got in the way:** `bd create --labels process` saying what broke.

Update the handoff's State when a PR opens or merges, so a crash loses nothing. When the
human says the context is running out, run `/handoff`. After each merge, run
`mshape track list` and act on what it prints under this track's row (a bead still open
though its PR merged: close it or say what is left). When its `done` column says `yes`, tell
the human the track is done; an empty `bd ready` is not enough, since it hides beads in
progress or blocked. `unknown` means bd or gh couldn't say: act on the note it prints, and
don't call the track done. Removing it is the human's or `/milestone`'s.

Review this skill when a fresh chat running it had to ask the human something the handoff
should have said.
