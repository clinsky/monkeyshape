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

## Install

```sh
bun add -d monkeyshape effect @biomejs/biome typescript @types/bun
```

monkeyshape runs on Bun and asks your `tsc` and `biome` which files they cover; `effect` is a
peer dependency. Add these files (the tests build a repo from exactly these blocks):

```jsonc
// tsconfig.json
{ "extends": "monkeyshape/tsconfig.base.json", "include": ["src", "test", "shape.config.ts"] }
```

```jsonc
// biome.json
{
  "root": true,
  "extends": ["monkeyshape/biome"],
  "files": { "includes": ["src/**", "test/**", "shape.config.ts", "*.json"] }
}
```

```ts
// shape.config.ts
import { defineConfig } from "monkeyshape";

export default defineConfig({
  arch: {
    modules: {
      core: { description: "Deterministic logic. No host I/O." },
      adapters: { description: "Host I/O behind services.", mayImport: ["core"], hostAccess: true },
    },
  },
});
```

```md
<!-- AGENTS.md -->
# My project: commands, gotchas and decision authority for agents, in 150 lines or fewer.
```

Then make it your gate: `tsc && biome ci --error-on-warnings && mshape check && bun test`.

## What `mshape check` enforces

| Check | Removes |
|---|---|
| `arch` | Layering drift, host access from pure code (common paths, statically; not a sandbox), unvetted packages, import cycles |
| `rules` | Silent decoding, hidden clocks/env/timers, thrown errors, nested runtimes, spread errors |
| `refs` | Docs and comments that point at paths, scripts or decisions that don't exist |
| `budgets` | Bloated `AGENTS.md`, decision logs and memories; oversized files |
| `coverage` | Code that escaped the typechecker or the linter and rots silently |
| `skills` | Installed skills that agents can't see (a broken `.claude/skills` link) or that lag the package |

Existing violations can be grandfathered with `mshape baseline --init`; counts may then only
go down. Every escape hatch (`// shape-ignore <rule>: <reason>`, config allowances) needs a reason.

Early (0.x). What ships and what's next: [docs/roadmap.md](docs/roadmap.md). MIT licensed.
