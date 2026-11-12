# monkeyshape

Opinionated checks, configs and a working loop for humans and coding agents building
software together on **Bun**, **TypeScript**, **Effect** and **beads**.

Agents write a lot of prose and forget most of it. The prose goes stale, and the next agent
builds on it anyway.

A rule in `AGENTS.md` works only if an agent loads it and notices that it applies. A check
runs every time and takes no room in context until it fires. So monkeyshape turns lessons
about code and docs alike into checks, and puts a hard cap on everything loaded into every
session. Less prose gets written, and the prose that's left matters more.

The working loop splits the work. You and the agents plan together at three horizons: the
roadmap (months), the milestone (this batch of work) and each track's handoff (today), with
many agents in parallel, one per track. The CLI does the mechanical parts (worktrees,
handoffs, messages, the gate), skills guide the judgement, and you set priorities and merge.
Each half feeds the other: the gate checks the loop, and each milestone turns mistakes into checks.

On a repo with two deliberate violations:

```console
$ mshape check
src/core/cache.ts:1  rules/no-nondeterminism
  reads the wall clock. Use Clock or DateTime.now so tests control time.

src/core/client.ts:1  arch/host-access
  imports readFile from 'node:fs/promises', but module 'core' has no hostAccess. Reach the host through a service in an adapter module, or use a pure operation.

  arch      failed          3 files in 2 modules
  sources   passed          4 TypeScript files: 3 in sources, 1 exempt
  refs      passed          1 doc, and comments in TypeScript
  budgets   passed          the loaded docs, decisions, memories and 4 TypeScript files' lengths
  coverage  passed          4 TypeScript files against tsc's and biome's own file lists; 3 data files parsed
  files     passed          9 files against the 1.0 MiB cap
  rules     failed          3 files in sources
  skills    not-applicable  no installed skills
  sync      not-applicable  sync has not run here: no .agents/skills/monkeyshape.json
  beads     not-applicable  no .beads/

       1  arch/host-access
       1  rules/no-nondeterminism

mshape check failed: 2 problems
```

## Quick start

```sh
bunx --package monkeyshape mshape init my-app
cd my-app && bun run check
```

`init` installs and commits a repo whose gate passes, with the five skills the table runs. It
needs Bun 1.4.2 or later, git, beads' `bd`, and `gh` for the loop. An existing repo: [docs/adopting.md](docs/adopting.md).

| Start a fresh agent in | Then run | What happens |
|---|---|---|
| Main checkout | `/roadmap` and a brain-dump | You and the agent agree the direction in `docs/roadmap.md`. |
| Main checkout | `/milestone` and your priorities | You agree a goal met on real data. The agent writes the plan, files the beads and splits the work into tracks, each with its own worktree and agent. |
| Each track's worktree | `/track` | Agents work in parallel, one per track, each from its own handoff, beads and mail, so its context holds one line of work. Each opens PRs. |
| Main checkout | `/review-pr <n>` | Another agent runs the PR on real data and posts findings until it can say LGTM. You merge. |

When a session's context runs low, run `/handoff`, then `/track` in a fresh one. When every
track is done (`mshape track list`), run `/milestone` again. In full: [docs/workflow.md](docs/workflow.md).

## What `mshape check` catches

| Check | Catches |
|---|---|
| `arch` | Layering drift, host access from pure code (common paths, statically; not a sandbox), unvetted packages, import cycles |
| `rules` | Silent decoding, hidden clocks/env/timers, thrown errors, nested runtimes, spread errors |
| `refs` | Docs and comments that point at paths, scripts or decisions that don't exist |
| `budgets` | Bloated `AGENTS.md`, README, decision logs and memories; oversized files |
| `coverage`, `sources` | Files the typechecker, linter or rules skip, other languages with no command checking them, data files that don't parse |
| `files` | Files over the size cap, `.env` files, vendored tarballs that don't match their record |
| `skills`, `sync` | Skills agents can't see (a broken `.claude/skills` link), and skills, `.beads/PRIME.md`, the PR template or hooks out of step with the installed package |
| `beads` | Open beads no track owns, deferred beads still in a track, `TODO`s naming a closed bead |

Existing violations can be grandfathered with `mshape baseline --init`; counts may then only
go down. Every escape hatch (`// shape-ignore <rule>: <reason>`, config allowances) needs a reason.

Early (0.x). What ships and what's next: [docs/roadmap.md](docs/roadmap.md). MIT licensed.
