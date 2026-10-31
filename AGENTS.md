# monkeyshape

monkeyshape encodes one way for humans and coding agents to build together on Bun,
TypeScript, Effect and beads: checks over prose, real data over polish, small budgets for
anything loaded automatically. This repo is the package (`mshape`) and is held to its own
gate: if a check is too strict for this repo, fix the check, not the repo.

## Commands

| Command | What |
|---|---|
| `bun install --frozen-lockfile` | Install (pinned toolchain) |
| `bun run check` | The gate: typecheck, biome, `mshape check` on this repo, tests. Green before every PR. |
| `bun run fix` | Apply biome formatting and safe fixes |
| `bun src/cli/main.ts garden` | Budgets and escape hatches |
| `bun src/cli/main.ts rules` | Custom rules and the bug class each removes |

## Where to start

- `shape.config.ts`: the module map. It is the layout; nothing else restates it.
- `src/core/check.ts`: runs every check over a `Snapshot`. Checks are pure; `src/adapters/` loads.
- `src/core/rules/registry.ts`: the custom rules. `src/core/rules/engine.ts` owns scope,
  allowances and `shape-ignore` comments, so rules only report offsets.
- `plan/MILESTONE.md`: the current milestone, its tracks and the interfaces between them.
  If you are in a track worktree, your handoff is `.handoffs/<track>.md`.
- `docs/roadmap.md`: direction, and a status table saying what ships. Direction, not rules:
  rewrite it in place when a piece ships, and never cite its sections from code or here.

## Gotchas

- oxc offsets are UTF-16 code units, the same as JS string indices: use `lineAt`, never bytes.
  Guarded by `test/core/model.test.ts`.
- A rule's fixture is source text inside a test file. Tests are outside `sources`, so a
  fixture full of `throw` doesn't trip this repo's own gate.
- `parse` caches per path and text. Tests that reuse a path with new text get a fresh parse;
  the cache is keyed on both.
- Biome base config lives in `config/` and is consumed through `extends`; a rule turned on
  there lands in every adopter on their next bump, so it must already pass here.
- `node_modules/.bin/*` shims start with `#!/usr/bin/env node`, and adopters may have only
  Bun: run tools as `[process.execPath, bin]`. A tool that can't run degrades to a `note:`,
  never silently. Guarded by `test/integration/consumer.test.ts`.
- `template/` is what `mshape init` copies; its JSON configs are generated in
  `src/core/scaffold.ts` instead, since a `biome.json` there would be a nested root for biome.
  Guarded by `test/integration/init.test.ts`, which runs the new repo's own gate.
- The code blocks in `docs/adopting.md` are the consumer test's fixture, and the README's
  `$ mshape check` block its expected output: edit both as code.

## Adding a rule

One file in `src/core/rules/`, one entry in `registry.ts`, and `test/rules/<id>.test.ts` with
at least one source that must fail and one that must pass. The message says why and what to
do instead; `bugClass` names what the rule removes. If it would fire on this repo, it fires on
adopters too: fix this repo first, or the rule.

## Rules that aren't mechanical

- Public repo: examples and messages stay generic. No names of private projects or people.
  (Can't be a check: the names that matter are exactly the ones this repo must not contain.)
- A check's message must let an agent fix the violation without reading anything else.
  (Judgement about wording; reviewed in PRs.)

## Decision authority

Needs the maintainer: priorities, publishing to npm, a new runtime dependency, anything
public beyond a PR. Agents decide everything else (design, refactors, rules, docs, beads) and
explain it in the PR body.

## Working agreements

- Written text is a hypothesis; code and tests are the truth. When a doc, decision or bead
  disagrees with the code or with common sense, fix the text and carry on.
- One fact, one home. Link to `DECISIONS.md` entries by slug; never restate them.
- Agents commit, push and open PRs; the maintainer merges. The PR body is the narrative:
  what changed and why, gate output, what bug class a new check closes, what's not done.
- Work is tracked in beads (`bd ready`). A bead is a pointer to intent, not a spec.
