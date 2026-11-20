# {{name}}

What this repo is, in two sentences. The `roadmap` skill fills this in from the first
brain-dump.

`.beads/PRIME.md`, printed at every session start, is the working loop monkeyshape decides:
beads, tracks and messages, pull requests. This file is what this repo decides, and wins
where the two differ.

## Commands

| Command | What |
|---|---|
| `mshape gate` | The gate: `cargo fmt --check`, clippy with `-D warnings`, `mshape check`, `cargo test`. Green in CI before review; `track pr` runs its fast stages before each push. |
| `cargo fmt --all` | Apply rustfmt |
| `mshape sync` | Rewrite what monkeyshape owns here, the workspace lints in `Cargo.toml` among them |
| `bd ready` | Work that is ready to pick up |

## Where to start

- `shape.toml`: the module map, one module per crate. It is the layout; nothing else
  restates it.
- `rust-toolchain.toml`: the pinned toolchain; rustup installs it on the first cargo command.
- `DECISIONS.md`: live decisions, each with the check that enforces it.
- `docs/roadmap.md`: direction, with a status table first. Direction, not rules: never cite
  its sections from code or here.
- `plan/`: the current milestone. In a track worktree, your handoff is `.handoffs/<track>.md`.

## Gotchas

- The workspace lints in the root `Cargo.toml` are `mshape sync`'s: change one under
  `[rust.lints.clippy]` or `[rust.lints.rust]` in `shape.toml`, then run sync. A crate
  opts in with `[lints] workspace = true`, which `cargo new` writes inside this workspace.
- An escape from a lint is `#[expect(clippy::<lint>, reason = "...")]`, never `#[allow]`:
  the lints require the reason, and `expect` fails once it suppresses nothing.

Add one when a mistake is worth a line, and replace it with a check when it can be.

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
