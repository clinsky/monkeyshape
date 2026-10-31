# Adding monkeyshape to an existing repo

A new repo should start with `mshape init` (see the README). This is the manual setup, for a
repo that already exists. The tests build a repo from exactly the blocks below and run its
gate, so they work as written.

## Install

```sh
bun add -d monkeyshape effect @biomejs/biome typescript @types/bun
```

monkeyshape runs on Bun and asks your `tsc` and `biome` which files they cover; `effect` is a
peer dependency. Add these files, merging into any you already have:

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

## Existing violations

Try the checks before committing to them: `mshape check --config <path>` runs against the
repo with a config kept elsewhere. When you adopt, `mshape baseline --init` grandfathers
every current violation per file; counts may then only go down, so in-flight work sees no
churn. Review the baseline's diff like code.

## The working loop

The skills and the conventions (`docs/workflow.md` in the package) assume the layout `init`
creates: docs/roadmap.md, plan/, notes/ and a decision-authority section in AGENTS.md.
Adopting them in an existing repo is not yet guided; until it is, start a scratch repo with
`mshape init` and copy what you need from it.
