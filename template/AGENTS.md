# {{name}}

What this repo is, in two sentences. `/roadmap` fills this in from the first brain-dump.

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

## Decision authority

Needs the maintainer: priorities, publishing, a new runtime dependency, anything public
beyond a PR. Agents decide everything else and explain it in the PR body.

## Working agreements

- Written text is a hypothesis; code and tests are the truth. When a doc, decision or bead
  disagrees with the code, fix the text and carry on.
- One fact, one home. Link to `DECISIONS.md` entries by slug; never restate them.
- Agents commit, push and open PRs; the maintainer merges. The PR body is the narrative.
- Work is tracked in beads (`bd ready`). A bead is a pointer to intent, not a spec.
