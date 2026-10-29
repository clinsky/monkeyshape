# Decisions

Live decisions only. Overwrite an entry to change it; git keeps the history.

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
Decision: `mshape init` and `mshape skills sync` install shared skills into .agents/skills, which Codex and other agents read, and commit the symlink .claude/skills with the text ../.agents/skills, since Claude Code reads project skills only from .claude/skills.
Tempting wrong fix: Copy the skills into both directories, which drift apart; or an absolute link, which points every clone and worktree back at one machine's checkout.
Evidence: verified 2026-10-29: Claude Code listed a skill reached only through the link, in a repo and in a nested worktree with a skill of its own.
Enforced by: test/integration/init.test.ts, test/adapters/skills.test.ts
Revisit when: Claude Code reads .agents/skills itself.
