# {{name}}

What this repo is, in two sentences. `/roadmap` fills this in from the first brain-dump.

`.beads/PRIME.md`, printed at every session start, is the working loop monkeyshape decides:
beads, tracks and messages, pull requests. This file is what this repo decides, and wins
where the two differ.

## Commands

| Command | What |
|---|---|
| `bun install --frozen-lockfile` | Install (pinned toolchain) |
| `bun run check` | The gate: typecheck, biome, `mshape check`, tests. Green before every PR. |
| `bun run fix` | Apply biome formatting and safe fixes |
| `bd ready` | Work that is ready to pick up |

## Where to start

- `shape.config.ts`: the module map. It is the layout; nothing else restates it.
- `DECISIONS.md`: live decisions, each with the check that enforces it.
- `docs/roadmap.md`: direction, with a status table first. Direction, not rules: never cite
  its sections from code or here.
- `plan/`: the current milestone. In a track worktree, your handoff is `.handoffs/<track>.md`.

## Gotchas

None yet. Add one when a mistake is worth a line, and replace it with a check when it can be.

## Real-data probes

What a reviewer runs, beyond the gate, to see a change work on real data: one row per probe,
each a command and what it should print. `review-pr` runs each the PR could affect. None yet:
add the first with the first real target.

## Decision authority

Needs the maintainer: priorities, publishing, a new runtime dependency, anything public
beyond a PR. Agents decide everything else and explain it in the PR body.

## Working agreements

- Written text is a hypothesis; code and tests are the truth. When a doc, decision or bead
  disagrees with the code, fix the text and carry on.
- One fact, one home. Link to `DECISIONS.md` entries by slug; never restate them.
