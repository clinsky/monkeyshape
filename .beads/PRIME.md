# The working loop

Loaded at every session start by `bd prime`. This is what monkeyshape decides for every repo
that uses it; AGENTS.md is what this repo decides, and wins where the two differ. Shipped by
monkeyshape and checked by `mshape check`: refresh it with `bun run --silent mshape sync`,
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
- Never `bd edit`: it opens an editor and blocks.

## Tracks: parallel work

- A track is a worktree on `track/<name>`, a handoff and a `track:<name>` label. In its
  worktree, `/track` picks the work up; `/handoff` when the context is running out.
- Message another track with
  `bun run --silent mshape msg send <track> --subject "<one line>" "<body>"`. Your unread
  mail is listed at session start and at each prompt; `bun run --silent mshape msg read <id>`
  reads one and marks it read. Never edit another track's handoff.

## Pull requests

- Agents commit, push and open PRs; the maintainer merges. A track has one PR open at a time,
  from its branch; a commit pushed while it is in review joins it.
- Batch beads of one theme into a PR of about 1000 to 2500 changed lines. That is a default
  for batching, not a gate: a smaller PR is fine when it unblocks work.
- `bun run check` is the gate, the same locally and in CI: green before every PR.
- The body has the sections of `.github/pull_request_template.md`. Write it to a file and
  open the PR with `gh pr create --body-file <file>`, which skips GitHub's template.
- Review runs in its own chat with `/review-pr <n>`. Answer every finding on the PR; before
  replying "fixed", rerun the reviewer's probes and try to break the fix with valid input.

## Who decides

AGENTS.md's decision-authority section. Unless it says otherwise, the maintainer owns
priorities, merging, publishing, spend and anything public beyond a PR; agents decide
design, refactors, docs, checks and beads, and explain them in the PR body.

## Before you stop

Commit and push what is done, update the handoff's State if you are in a track, and say
what is left. Text is a hypothesis: when a doc or bead disagrees with the code, fix the text.
