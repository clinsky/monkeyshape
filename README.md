# monkeyshape

Opinionated checks, configs and conventions for humans and coding agents building software
together on **Bun**, **TypeScript**, **Effect** and **beads**.

Agents write a lot of prose and forget most of it. The prose goes stale, and the next agent
builds on it anyway.

A rule in `AGENTS.md` works only if an agent loads it and notices that it applies. A check
runs every time and takes no room in context until it fires. So monkeyshape turns lessons
about code and docs alike into checks, and puts a hard cap on everything loaded into every
session. Less prose gets written, and the prose that's left matters more.

The other half is how people and agents split the work, so everyone can see who owns what:

- **Plans are made together**, at three horizons, each in one file: the roadmap (months), the
  milestone (the current batch of work) and each track's handoff (today). The agent
  interviews you, proposes and pushes back; you set the priorities, approve the plan and merge.
- **Agents own the code**, tests and docs. Each track is one agent's line of work, with its
  own worktree, branch and handoff, so its context stays small and focused.
- **Beads** give agents memory, an issue tracker and the order between tasks.
- **Tracks message each other** with `mshape msg`, so you never relay between chats.
- **Done** means it ran on real data, not just that the tests passed.

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

mshape check failed: 2 problems
```

## Quick start

```sh
bunx --package monkeyshape mshape init my-app
```

A new repo whose gate (`bun run check`) passes, with one starter test: Bun, TypeScript, Effect,
beads, the configs, CI, and five skills for your coding agent.

Then the working loop. For each step, start a fresh agent session (Claude Code, Codex or
another) in the directory the table names, then run the skill:

| Start the agent in | Run | What happens |
|---|---|---|
| Main checkout | `/roadmap` and a brain-dump | You and the agent agree the direction. It writes `docs/roadmap.md`. |
| Main checkout | `/milestone` and your priorities | You agree a goal that is met on real data. The agent writes the plan, files the beads and makes one worktree per track. |
| Each track's worktree | `/track` | One agent per track works its beads, messages other tracks and opens PRs. |
| Main checkout | `/review-pr <n>` | Another agent runs the PR on real data and posts findings until it can say LGTM. You merge. |

Tracks run in parallel, each in its own session. When a session's context runs low,
`/handoff` saves its state, and `/track` in a fresh session picks it up. When every track is merged,
`/milestone` starts the next round; `/roadmap` again only when the direction changes.

The conventions in full: [docs/workflow.md](docs/workflow.md). An existing repo:
[docs/adopting.md](docs/adopting.md).

## What `mshape check` enforces

| Check | Removes |
|---|---|
| `arch` | Layering drift, host access from pure code (common paths, statically; not a sandbox), unvetted packages, import cycles |
| `sources` | TypeScript no rule analyzes: each file is in `sources`, a test, a declaration, or exempt with a reason |
| `rules` | Silent decoding, hidden clocks/env/timers, thrown errors, nested runtimes, spread errors |
| `refs` | Docs and comments that point at paths, scripts or decisions that don't exist |
| `budgets` | Bloated `AGENTS.md`, decision logs and memories; oversized files |
| `coverage` | Code that escaped the typechecker or the linter and rots silently |
| `skills` | Installed skills that agents can't see (a broken `.claude/skills` link) or that lag the package |

Existing violations can be grandfathered with `mshape baseline --init`; counts may then only
go down. Every escape hatch (`// shape-ignore <rule>: <reason>`, config allowances) needs a reason.

Early (0.x). What ships and what's next: [docs/roadmap.md](docs/roadmap.md). MIT licensed.
