# The working loop

Loaded at every session start by `mshape prime`. This is what monkeyshape decides for every repo
that uses it; AGENTS.md is what this repo decides, and wins where the two differ. Shipped by
monkeyshape and checked by `mshape check`: refresh it with `mshape sync`,
never by hand.

## Beads: what is left to do

- Work is tracked in beads. A bead points to intent: why, and an outcome as acceptance; it
  is not a spec. No markdown TODO lists for work that outlives the session.
- `bd ready` lists what can start; `bd show <id>` reads one; `bd update <id> --claim` before
  you start it.
- `bd create --title "..." --description "..." --type task|bug|feature --priority 2`, with
  `--labels track:<name>` for a track's work, or `--labels process` when the process itself
  got in the way. `bd dep add <issue> <depends-on>` for an order between them.
- `bd close <id> --reason "..."` once the PR that does it has merged, not before.
- `bd remember "..."` keeps a lesson every session needs; memories are printed below this
  and are budgeted, so promote a lasting one to a check or AGENTS.md instead.
- Never `bd edit`: it opens an editor and blocks. Add to a bead's notes with
  `bd update <id> --append-notes "..."`: `--notes` replaces what is there.
- Run `bd sync` only where `bd config get dolt.auto-push` prints `true`, when you start and
  before you stop: it pulls other clones' beads, then pushes what auto-push's five-minute
  throttle held back. Anywhere else, don't: it may offer to set up a remote, and where
  beads are published is the maintainer's call.

## Tracks: parallel work

- A track is a worktree on `track/<name>`, a handoff and a `track:<name>` label. There, the
  `track` skill (`/track`; `$track` in Codex) picks up the work; `handoff` when context ends.
- Message another track with
  `mshape msg send <track> --subject "<one line>" "<body>"`. Your unread
  mail is listed at session start and at each prompt; `mshape msg read <id>`
  reads one and marks it read. Put `--` before a body that starts with `--`. Never edit
  another track's handoff.
- A `[mshape] Message from <track>: <subject>` notice can arrive at any time, even while
  idle. It marks nothing read: finish what you are doing if it can wait, then read it.

## Pull requests

- Agents commit, push and open PRs; the maintainer merges. A track has one PR open at a time,
  from its branch. While it is in review, the branch takes only commits that answer the
  review; the next work is committed on a local branch and pushed once the PR merges.
- Batch beads of one theme into a PR of about 1000 to 2500 changed lines. That is a default
  for batching, not a gate: a smaller PR is fine when it unblocks another track or ends one.
- `mshape gate` is the gate, the same locally and in CI: green in CI before review.
  `track pr` runs `mshape gate --fast` before each push; run it whole outside a track.
- The body has the sections of `.github/pull_request_template.md`, each bead a list item
  starting with its id. Write it to a file. In a track, open and refresh the PR with
  `mshape track pr --title "<title>" --body-file <file>` (after the first
  time, `track pr` alone): it runs `mshape gate --fast`, pushes, and fills the Gate
  section; CI runs the whole gate, and `track pr --wait` records its result there.
  Outside a track, `gh pr create --body-file <file>`, which skips GitHub's template.
- Review runs in its own chat (the `review-pr` skill). `mshape review post` mails the track
  the review; `track pr` mails the reviewer each answering push. Answer every finding on the
  PR; before replying "fixed", rerun the reviewer's probes and try to break the fix.
- Don't poll or ask to be told: `mshape msg watch pr <n>` (or `bead <id>`, `ci <sha>`,
  `main`) mails you when it merges or closes, CI ends, or main goes red and green again.

## Who decides

AGENTS.md's decision-authority section. Unless it says otherwise, the maintainer owns
priorities, merging, publishing, spend and anything public beyond a PR; agents decide
design, refactors, docs, checks and beads, and explain them in the PR body.

## Before you stop

Commit what is done and push it unless it waits for a PR to merge, `bd sync` as above,
in a track put in its handoff what no command shows, and say what is left. Text is a
hypothesis: when a doc or bead disagrees with the code, fix the text.
