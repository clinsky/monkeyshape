# monkeyshape

Opinionated checks, configs and conventions for humans and coding agents building software
together on **Bun**, **TypeScript**, **Effect** and **beads**.

Agents write a lot of prose and forget most of it. A rule written in `AGENTS.md` works only if
it is loaded and noticed; a check works every time and costs no context until it fires.
monkeyshape turns lessons into checks, keeps everything loaded automatically on a budget,
and treats real-world results as the judge of done.

```console
$ mshape check
src/core/cache.ts:1  rules/no-nondeterminism
  reads the wall clock. Use Clock or DateTime.now so tests control time.

src/core/client.ts  arch/host-access
  imports 'node:fs/promises', but module 'core' has no hostAccess. Reach the host through a service in an adapter module.

mshape check failed: 2 problems
```

## Quick start

```sh
bunx --package monkeyshape mshape init my-app
```

A new repo whose gate (`bun run check`) passes empty: Bun, TypeScript, Effect, beads, the
configs, CI, and five skills for your coding agent. Then the working loop, one chat each:

1. `/roadmap` with a brain-dump: the direction, and one deferred epic per goal.
2. `/milestone` with your priorities: a plan with acceptance on real data, beads, and
   tracks, each its own worktree from `mshape track new`.
3. `/track` in each track's worktree: the agent works its queue and opens PRs.
4. `/handoff` when a chat's context runs low; a fresh chat runs `/track` to continue.
5. `/review-pr <n>` in its own chat; you merge.

The conventions in full: [docs/workflow.md](docs/workflow.md). An existing repo:
[docs/adopting.md](docs/adopting.md).

## What `mshape check` enforces

| Check | Removes |
|---|---|
| `arch` | Layering drift, host access from pure code (common paths, statically; not a sandbox), unvetted packages, import cycles |
| `rules` | Silent decoding, hidden clocks/env/timers, thrown errors, nested runtimes, spread errors |
| `refs` | Docs and comments that point at paths, scripts or decisions that don't exist |
| `budgets` | Bloated `AGENTS.md`, decision logs and memories; oversized files |
| `coverage` | Code that escaped the typechecker or the linter and rots silently |

Existing violations can be grandfathered with `mshape baseline --init`; counts may then only
go down. Every escape hatch (`// shape-ignore <rule>: <reason>`, config allowances) needs a reason.

Early (0.x). What ships and what's next: [docs/roadmap.md](docs/roadmap.md). MIT licensed.
