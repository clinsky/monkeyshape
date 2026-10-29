# Milestone 1: a new repo can be born

Epic `monkeyshape-iqf`. Planned 2026-10-29. Frozen for the milestone: when a track diverges,
it says so in its handoff; a divergence that changes another track's work or the goal is a
conversation with the maintainer, not an edit here.

## Goal, and how we'll know

The maintainer can start a new repo and run the whole working loop on it without
hand-made files:

1. `mshape init <name>` gives a repo whose gate passes empty, with beads, the five skills
   and a state directory.
2. `/roadmap` turns a brain-dump into `docs/roadmap.md` and deferred epics.
3. `/milestone` turns priorities into a plan, groomed beads and named tracks.
4. `mshape track new` makes each track's worktree and handoff; `/track` works it;
   `/handoff` hands it on; `mshape track rm` cleans it up.

**Acceptance on real data:** the next real repo is born this way. Every place the process
breaks or needs a hand-made file is filed as a bead labelled `process` here.

## Where we are

| Piece | Today |
|---|---|
| The gate (`mshape check`, baselines, base configs) | Shipped in v0.1 |
| Creating a repo | By hand: copy configs, write AGENTS.md, `bd init --skip-agents` |
| Tracks and worktrees | By hand: `git worktree add`, a handoff written from memory |
| Skills | None in the package; the working loop exists only as the roadmap's description |

## What changed, and why

The roadmap planned `init` for v0.2 and skills for v0.3. The next repo needs both, and the
working loop was settled with the maintainer: skills carry judgement, the CLI carries
everything deterministic (docs/roadmap.md, "The working loop"). So both move here, and the
remaining rules, the agentic layer, `validate` and adoption become deferred epics.

## Interfaces the tracks share

Agree these before diverging; change them only by telling the other tracks (handoff
Messages) and the maintainer.

- **Layout:** `src/core/layout.ts` is the only source of track paths and names: worktree
  `<parent>/<repo>@<track>`, branch `track/<track>`, label `track:<track>`, handoffs in
  `<parent>/<repo>-state/handoffs/<track>.md`, symlink `.handoffs` in every checkout.
  Already merged with this plan, with tests.
- **CLI surface** (implemented by `init` and `tracks`, called by `skills`):
  - `mshape init <name>`
  - `mshape skills sync` (refresh `.agents/skills` from the installed package)
  - `mshape track new <name>`, `mshape track list`, `mshape track current` (name only on
    stdout; exit 1 outside a track), `mshape track rm <name> [--force] [--keep-handoff]`
- **Handoff format** (`monkeyshape-iqf.7`; owner `tracks`, consumer `skills`):

  ```md
  # Track: <name>
  Status: stub | active
  Queue: bd ready --label track:<name>

  ## Charter
  ## State (<date>)
  ## Lessons not yet promoted
  ## Traps
  ## Messages
  ```

  A stub has `Status: stub` and an empty charter; `/track` then interviews the human.
- **Package layout:** templates in `template/`, skills in `skills/<name>/SKILL.md`; both ship
  in the npm package. `init` copies `skills/` wholesale, so the `skills` track can add files
  without coordinating.

## Tracks

| Track | Charter | Beads | Acceptance |
|---|---|---|---|
| `init` | `mshape init`: template, toolchain, beads, state directory, skills install; the end-to-end test | `iqf.1`, `iqf.2`, `iqf.3`, `iqf.13` | A temp repo from `init` passes its gate; the end-to-end test runs in the gate |
| `tracks` | `mshape track new / list / current / rm`; the handoff format and stub | `iqf.4`, `iqf.5`, `iqf.6`, `iqf.7` | Each command tested against real git worktrees; the handoff format is parsed in a test |
| `skills` | The five skills: `roadmap`, `milestone` (with grooming and gardening), `track`, `handoff`, `review-pr` | `iqf.8` to `iqf.12` | Each skill uses only the CLI surface above; the refs check passes on them; the maintainer runs `/milestone` on this repo for milestone 2 |

`iqf.13` (end-to-end) waits on `init` and `tracks`; the `track` and `handoff` skills wait on
the handoff format. Everything else can start now.

## Decision points

- **Claude Code and `.agents/skills`** (`iqf.3`): if Claude Code doesn't read
  `.agents/skills`, `init` adds a `.claude/skills` symlink. The `init` track decides and
  records it in DECISIONS.md.
- **When `init` and `tracks` both work:** the maintainer tries them for real before the
  skills are polished; what breaks becomes `process` beads.

## Deferred, with reasons

- The remaining starter rules (`monkeyshape-hh2`), the agentic layer (`monkeyshape-v56`),
  `mshape validate` (`monkeyshape-97o`): no consumer needs them before the next repo exists.
- Adopting monkeyshape in an existing repo (`monkeyshape-36f`): learned better after one repo
  is born the new way.
- Selectable policy bundles (`monkeyshape-8h4`): no outside adopter yet.

## Spend

None: no model calls in this milestone's code.
