# monkeyshape

Checks, configs and conventions for humans and coding agents building software together on
**Bun**, **TypeScript**, **Effect** and **beads**.

Agents read a lot of prose and forget most of it. A rule written in `AGENTS.md` works only if
it is loaded and noticed; a check works every time and costs no context until it fires.
monkeyshape turns lessons into checks, keeps everything loaded automatically on a budget,
and treats real-world results as the judge of done.

## Install

```sh
bun add -d monkeyshape
```

```jsonc
// tsconfig.json
{ "extends": "monkeyshape/tsconfig.base.json", "include": ["src", "test"] }
// biome.json
{ "root": true, "extends": ["monkeyshape/biome"], "files": { "includes": ["src/**", "test/**"] } }
```

```ts
// shape.config.ts
import { defineConfig } from "monkeyshape";

export default defineConfig({
  arch: {
    modules: {
      schemas: { description: "Pure data contracts." },
      core: { description: "Deterministic logic.", mayImport: ["schemas"] },
      adapters: { description: "Host I/O behind services.", mayImport: ["schemas", "core"], hostAccess: true },
      cli: { description: "Composition root.", mayImport: ["schemas", "core", "adapters"], hostAccess: true },
    },
  },
});
```

Then add `mshape check` to your gate: `tsc && biome ci --error-on-warnings && mshape check && bun test`.

## What `mshape check` enforces

| Check | Removes |
|---|---|
| `arch` | Layering drift, host access from pure code, unvetted packages, import cycles |
| `rules` | Silent decoding, hidden clocks/env/timers, thrown errors, nested runtimes, spread errors |
| `refs` | Docs and comments that point at paths, scripts or decisions that don't exist |
| `budgets` | Bloated `AGENTS.md`, decision logs and memories; oversized files |
| `coverage` | Code that escaped the typechecker or the linter and rots silently |

Existing violations can be grandfathered with `mshape baseline --init`; counts may then only
go down. Every escape hatch (`// shape-ignore <rule>: <reason>`, config allowances) needs a reason.

## Status

Early (0.x). The design is in `SPEC.md`. MIT licensed.
