# Decisions

Live decisions only. Overwrite an entry to change it; git keeps the history.

An entry earns its slot when an agent reading only the code would be tempted to undo it
(name that tempting wrong fix), or when it is a policy call no test can express. A feature
design isn't one: it goes in the code. Nor is a lesson one test fully explains: that test,
named after it, is enough.

Add or retire an entry only in a PR that says why; its review applies the test above. At
the budget (`mshape garden` shows it), adding an entry retires one: move its reason into a
comment in the test or check that enforces it, then delete it. Raising the budget is the
maintainer's call.

## D-pure-checks: Checks are pure functions over a Snapshot
Decision: Every check takes the resolved config and a loaded Snapshot and returns violations. Only `src/adapters/` touches disk, git or `bd`.
Tempting wrong fix: Let a check read the file it needs. It works until checks need fixtures, and then every test needs a temp repo.
Evidence: verified: every check in `test/` runs on an in-memory Snapshot.
Enforced by: shape.config.ts (core has no hostAccess), test/core/
Revisit when: a check needs data too large to load up front.

## D-own-rule-engine: Custom rules run on the oxc AST inside mshape, not as Biome plugins
Decision: Rules are TypeScript visitors over oxc-parser's AST, run by one engine that owns scope, allowances, ignore comments and ratchets.
Tempting wrong fix: GritQL plugins in Biome. They lint, but per-path allowances with reasons, unused-ignore detection and per-file ratchet counts would each need a second mechanism.
Evidence: policy
Enforced by: src/core/rules/engine.ts
Revisit when: Biome plugins take per-path options and report machine-readable counts.

## D-strict-ratchet: A loose ratchet fails the gate
Decision: When a file has fewer violations than its baseline allows, `mshape check` fails until `mshape baseline --tighten` lowers the count.
Tempting wrong fix: Only warn, or tighten automatically during check. A warning lets fixed violations creep back unseen; a check that rewrites files breaks CI's read-only contract.
Evidence: policy
Enforced by: src/core/ratchet.ts, test/core/ratchet.test.ts
Revisit when: tightening by hand becomes a frequent chore in PRs.

## D-skills-link: Skills live in .agents/skills; .claude/skills is a committed relative link
Decision: `mshape init` and `mshape sync` install shared skills into .agents/skills, which Codex and other agents read, and commit the symlink .claude/skills with the text ../.agents/skills, since Claude Code reads project skills only from .claude/skills.
Tempting wrong fix: Copy the skills into both directories, which drift apart; or an absolute link, which points every clone and worktree back at one machine's checkout.
Evidence: verified 2026-10-29: Claude Code listed a skill reached only through the link, in a repo and in a nested worktree with a skill of its own.
Enforced by: src/core/skills.ts (the skills check), test/core/skills.test.ts, test/integration/init.test.ts, test/adapters/skills.test.ts
Revisit when: Claude Code reads .agents/skills itself.

## D-run-mshape: Hooks and skills run mshape as `bun run --silent mshape <args>`
Decision: Every repo has the package script `mshape` (`mshape` in a born repo, `bun src/cli/main.ts` here), and every hook and skill invokes it through `mshapeCommand` in src/core/hooks.ts. bun puts each ancestor's node_modules/.bin on a script's PATH, so a track worktree under .agents/worktrees with no node_modules runs the main checkout's install, in the worktree.
Tempting wrong fix: Bare `mshape`, which a hook's PATH lacks; `bunx mshape`, which fetches from the registry when nothing local resolves; or `$CLAUDE_PROJECT_DIR/node_modules/.bin/mshape`, which is missing in a worktree and in this repo.
Evidence: verified 2026-11-02 on bun 1.4.2: a born repo's root, a subdirectory and a track worktree without node_modules, with only bun and git on PATH.
Enforced by: test/integration/invoke.test.ts, test/core/hooks.test.ts
Revisit when: bun stops walking ancestors for node_modules/.bin, or a hook runs where bun isn't on PATH.
