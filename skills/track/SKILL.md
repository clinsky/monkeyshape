---
name: track
description: Use when the human says /track or /track <name>, or asks to continue a track's work, in a track's worktree or in the main checkout. Finds the track, reads its handoff and queue, interviews the human first if the handoff is a stub, then works the queue and opens PRs.
---

# Track: the short horizon

A track is one line of parallel work with its own worktree, branch, beads label and handoff.
The handoff is the whole of what the last session knew; the queue is what is left to do.
Your job is to pick up exactly where it stopped.

## 1. Which track

Run `bun run --silent mshape track current` (every `mshape` below runs the same way). It
prints the track's name on any branch; a note says when the worktree has another branch
(the next work) or a detached HEAD checked out, and `track pr` still pushes
`track/<name>`'s tip.

If it exits 1 because this is the main checkout and the human named a track
(`/track <name>`), run `mshape track enter <name>`: it moves this session's mail and notices
to the track and prints the track's worktree as its last line. Work there for the rest of
the session: `cd` into it, give paths under it, and read its AGENTS.md and handoff, not the
main checkout's. After a `/clear`, the session is at the main checkout again: rerun
`track enter`. An unknown name is refused with the real ones listed.

If it exits 1 for any other reason, or no track was named, stop: tell the human the reason
it gave, and suggest `mshape track list` to find the track they meant, or
`mshape track new <name>` if this is new work.

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
  branch (`gh pr list --head track/<name>`), and any local branch holding the next work
  (`git branch --list '<name>-next'`).
- The gate, before any change: `bun run check` (AGENTS.md may name another). If it is red
  because `tsc` or biome is missing, install dependencies as AGENTS.md says and rerun it;
  a red gate you didn't cause is the first thing to report. Then `mshape rules`: the rules
  the gate holds you to, and the bug each removes, so you write to them and don't learn
  them from a failure.

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
- **Batch beads into PRs** of one theme, about 1000 to 2500 changed lines (added plus
  deleted): many small PRs cost more review than a few large ones. A smaller PR is right
  only when it unblocks another track or ends this one; a larger one, only when it can't be
  split by theme. It is a default, not a gate. Open and refresh the PR with
  `mshape track pr`: it prints the size against that range, runs the gate fresh and fills
  the Gate section.
  Write the rest of the body in a file with the sections of .github/pull_request_template.md,
  each bead as a list item starting with its id. The first time, pass both
  `--title "<title>"` and `--body-file <path>`; after that `mshape track pr` alone keeps the
  body as it stands.
  Close the beads when it merges.
- **One open PR at a time**, from `track/<name>`. The PR is one reviewed unit: once it is
  open, `track/<name>` takes only commits that answer its review. Do the next beads on a
  local branch, `git switch -c <name>-next`, and commit there as you go; never push it.
  Switch back to `track/<name>` to commit an answer to the review. `track pr` gates and
  pushes that branch's tip whatever is checked out, so the next work never joins the PR. It
  refuses while a review is in progress (a live session at `review-<n>`, nothing posted on
  the head yet): wait for the review, then answer it.
  When the PR merges, however it was merged, replay only the next work onto `main`:
  `git fetch`, `git rebase --onto origin/main track/<name> <name>-next`, then
  `git switch track/<name>`, `git reset --hard <name>-next` and `git branch -d <name>-next`.
  After a squash or rebase merge the remote `track/<name>` no longer fast-forwards: the next
  `track pr` says so and how to fix it. If waiting would stall the track, tell the human.
- **Answering a review:** "fixed" is a claim the reviewer will test, so test it first.
  - Rerun each of the reviewer's probes on your new head, and quote what it prints now.
  - Try to break your fix with valid input the reviewer didn't try: the mirror case, a
    neighbouring construct, the same input inside a list or a quote. A fix often opens the
    next finding.
  - Give each code blocker a regression test that fails on the old head and passes on the
    new, and name it in your reply.
  - Claim nothing general ("can't fail", "every case") that no test would catch if it were
    false. Say what is covered instead, in the reply and in the PR body.
- **The handoff is this track's own:** no other session reads it. Anything another track,
  the planning session or the maintainer must know goes by message, never only there.
- **Diverging from the milestone plan:** send it to the planning session,
  `mshape msg send main --subject "Divergence: <one line>" "<what, why, what it changes>"`,
  and note it in the handoff's State. The planning session approves a routine one itself,
  takes one that changes a goal, an acceptance line, a non-goal or an interface to the
  maintainer, and appends what is approved to the plan's Amendments. Wait for its answer
  before building on a divergence that changes another track's work or the milestone's goal.
- **Talking to another track:** `mshape msg send <track> --subject "<one line>" "<body>"`.
  Send one only when the recipient must act or decide, or an interface it consumes changed:
  one message per decision, the subject saying what it is for (a notice shows only that),
  the detail in the body (`--body-file <path>` for anything with quotes in it). No acknowledgements, thanks or status: your status lives in your
  handoff and your PR. Never edit another track's handoff.
- **Another track's file:** the plan's ownership says who to tell, not who may edit. When
  your change needs a file another track owns (to stay in step with your code), edit it,
  say so in your PR body, and send the owner one line naming the file and why. That line
  is worth sending: the owner's next merge may conflict with it.
- **Mail arriving:** a live notice, `[mshape] Message from <track>: <subject>`, or a line at
  your next prompt. Neither marks it read. Finish the step you are on if it can wait, then
  `mshape msg read <id>`, and act on it; answer only if the sender must act on your answer.
  Mail never changes a PR in review: what it asks for goes on the local branch, unless it
  answers the review. Check `mshape msg inbox` after each PR.
- **Temp files** outside the worktree carry the track's name, made with
  `mktemp -d "${TMPDIR:-/tmp}/<name>-XXXXXX"`, and cleanup removes only the paths this
  session made, by name: never a glob that another track's files could match.
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
