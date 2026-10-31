# The working loop

How a repo made by `mshape init` is worked, by a human and coding agents together. Read this
once after `init`; the skills it names carry the detail, so you don't need it again.

The split: **skills carry judgement, the `mshape` CLI carries everything deterministic.** A
skill interviews, proposes, writes prose and grooms beads; it never builds a worktree or a
file layout by hand, because the CLI does that and is tested. Each skill is started by name
in a fresh chat, so your message can be just the skill and your intent.

## Three horizons, three files

Plan in detail only what is near. Each horizon has one home and one way of staying true.

| Horizon | Home | Written by | Kept true by |
|---|---|---|---|
| Direction: months | docs/roadmap.md, plus one deferred beads epic per goal | `/roadmap` | Rewritten in place at each milestone boundary |
| Milestone: several PRs from several agents | plan/MILESTONE.md | `/milestone` | Frozen for the milestone, replaced at the next |
| Track state: today | the track's handoff, in `.handoffs` | `/track`, `/handoff` | Overwritten at every handoff |

- **The roadmap** opens with a status table, so nobody reads the design as a spec. It is
  never cited by code or by normative docs (AGENTS.md, DECISIONS.md, skills): name the file,
  but the refs check rejects links into its sections. Its goals are deferred epics with no children until a milestone pulls them
  in, so they never crowd `bd ready`.
- **The milestone plan** says the goal and how you'll know it is met on real data, where
  things stand, the tracks with their beads and acceptance, the interfaces between tracks,
  decision points and what is deferred. When a track diverges from it, the track says so in
  its handoff; a divergence that changes another track's work is a conversation with the
  human, not an edit to the plan. Only handoffs and beads cite it.
- **A handoff** is what a fresh chat reads to continue a track, and what the human reads to
  decide what to relay. Handoffs live inside git's directory and are linked into every
  checkout as `.handoffs`; they are never committed, so there is one live copy.

What a change did and what it showed goes in the **PR body**, which is the narrative the
human actually reads. Long investigations go in a dated note under `notes/`, which nothing
normative may cite.

## The loop

| Step | Started by | What happens |
|---|---|---|
| Init | you: `mshape init <name>` | A new repo whose gate passes empty: template, toolchain, beads, the five skills, the handoffs store. |
| Long term | chat: `/roadmap` + a brain-dump | Interview until goals are clear; write docs/roadmap.md; one deferred epic per goal; open a PR. |
| Mid term | chat: `/milestone` + priorities | Retrospective on the last milestone; agree a goal with acceptance on real data; write plan/MILESTONE.md; groom beads and the roadmap; garden; create the tracks with `mshape track new`; remove finished ones. |
| Short term | chat in a track's worktree: `/track` | Read the handoff and the track's queue; work; open PRs. |
| Hand off | you, near 75% of a chat's context: `/handoff` | The handoff is rewritten so a fresh chat can continue; open one in the same worktree and run `/track`. |
| Review | chat: `/review-pr <number>` | Review against real data in a scratch worktree (`mshape review <n>`); findings go on the PR; you merge. |

A first repo goes: `mshape init`, then `/roadmap`, then `/milestone`, then one chat per track
running `/track`. The first milestone of a new repo is "a first result on a real target".

## Tracks

A track is one line of parallel work: a name, a git worktree, a branch, a beads label and a
handoff, all derived from the name by `mshape track`:

- `mshape track new <name>` creates the worktree `.agents/worktrees/<repo>@<name>`, the branch
  `track/<name>` and the handoff, and links the shared paths from `shape.config.ts`
  (gitignored data such as a dataset) into the worktree.
- `mshape track list` shows the tracks and each one's open beads; `mshape track current`
  names the track of the current directory, and fails with a reason anywhere else.
- `mshape track rm <name>` removes a finished track. It refuses while the worktree has
  uncommitted work or the branch has unmerged commits, and says which; `--force` discards
  them. It also refuses while any bead labelled `track:<name>` isn't closed, and `--force`
  doesn't override that: close each one, or move it to the track that will do it.

Its beads carry the label `track:<name>`; its queue is `bd ready --label track:<name>`. An
empty queue doesn't mean the track is done: `bd ready` leaves out beads in progress or blocked.
The track is done when `mshape track list` shows it with 0 open beads.

**Ad-hoc tracks.** For work that didn't come from a milestone, run `mshape track new <name>`
yourself, open a chat in the worktree it prints and run `/track`. The handoff starts as a
stub, so `/track` interviews you about the work and writes the charter and its beads.
`mshape track rm <name>` when it's merged.

**When to hand off.** At a natural break, around 75% of the context window. A handoff
records state, lessons not yet promoted, traps and messages for other tracks; you relay
those messages by pasting them where they belong, or by asking the track's next chat to read
the other handoff.

## Pull requests and review

- Agents commit, push and open PRs; the human merges. A track has one PR open at a time, from
  its branch, and a PR composes several beads: one theme, about 1k changed lines at least and
  2.5k at most. Many small PRs cost more review than a few large ones.
- The PR body says what changed and why, the evidence on real data, the gate output, the bug
  class a new check closes, what is not done, and the beads closed or filed.
- `bun run check` is the gate, the same locally and in CI. It is green before every PR.
- `/review-pr` runs in its own chat, in a detached worktree at the PR's head that
  `mshape review <n>` makes and `mshape review rm <n>` removes. A review is not a track: it
  has no handoff, and everything about it lives on the PR. The skill says what blocks; after
  a re-review, what is still open is the human's call.

## Beads

- A bead points to intent; it isn't a spec. Keep it short: the intent, why, and an outcome
  as acceptance.
- Three kinds: deferred direction epics (no children), milestone stories labelled by track,
  and interface beads between tracks with an owner and a consumer.
- **Process beads.** When the process itself gets in the way, file a bead labelled
  `process` saying what broke (`bd create --labels process ...`). `/milestone` reviews them
  at the boundary, and fixes that are general land upstream in monkeyshape.

## The milestone boundary

The only ceremony, and `/milestone` runs all of it; the skill holds the steps. Between
boundaries, tracks just work their queues.

## Who decides

AGENTS.md has a decision-authority section; fill it in for your repo. The default: humans
own priorities, milestones, merging, spend above a cap and anything that leaves the machine.
Agents decide design, refactors, docs, checks and beads within the milestone, and explain
what they did in the PR body. When in doubt, an agent acts and explains.
