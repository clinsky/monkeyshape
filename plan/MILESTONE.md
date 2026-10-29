# Milestone 1: a new repo can be born

Epic `monkeyshape-iqf`. Planned 2026-10-29. Frozen for the milestone: when a track diverges,
it says so in its handoff; a divergence that changes another track's work or the goal is a
conversation with the maintainer, not an edit here.

## Goal, and how we'll know

The maintainer can start a new repo and run the whole working loop on it without
hand-made files:

1. `mshape init <name>` gives a repo whose gate passes empty, with beads, the five skills
   and a state directory.
2. `/roadmap` turns a brain-dump into `docs/roadmap.md` and deferred epics.
3. `/milestone` turns priorities into a plan, groomed beads and named tracks.
4. `mshape track new` makes each track's worktree and handoff; `/track` works it;
   `/handoff` hands it on; `mshape track rm` cleans it up.
5. A new user knows what to do after `init`, without reading the roadmap: `init` prints the
   next step, the README gives the loop in brief, and `docs/workflow.md` gives the
   conventions in full. The installed skills are checked by `mshape check`, not trusted.

**Acceptance on real data:** the next real repo is born this way. Every place the process
breaks or needs a hand-made file is filed as a bead labelled `process` here.

## Where we are

| Piece | Today |
|---|---|
| The gate (`mshape check`, baselines, base configs) | Shipped in v0.1 |
| Creating a repo | By hand: copy configs, write AGENTS.md, `bd init --skip-agents` |
| Tracks and worktrees | By hand: `git worktree add`, a handoff written from memory |
| Skills | None in the package; the working loop exists only as the roadmap's description |

## What changed, and why

The roadmap planned `init` for v0.2 and skills for v0.3. The next repo needs both, and the
working loop was settled with the maintainer: skills carry judgement, the CLI carries
everything deterministic (docs/roadmap.md, "The working loop"). So both move here, and the
remaining rules, the agentic layer, `validate` and adoption become deferred epics.

## Interfaces the tracks share

Agree these before diverging; change them only by telling the other tracks (handoff
Messages) and the maintainer.

- **Layout:** `src/core/layout.ts` is the only source of track paths and names. Everything
  lives under the repo's `.agents/`, so nothing clutters the directory around it: worktree
  `<repo>/.agents/worktrees/<repo>@<track>` (gitignored), branch `track/<track>`, label
  `track:<track>`. Amended 2026-10-29 from sibling directories, before any track started, at
  the maintainer's request.
  - **The main checkout comes from git, never from the directory:** every command resolves
    `git rev-parse --path-format=absolute --git-common-dir` and derives the main checkout
    from it (`mainCheckout`). Nested worktrees are inside the repo, so walking up the
    directory tree would find the wrong root.
  - **Handoffs live inside git's directory:** `<common>/monkeyshape/handoffs/<track>.md`,
    with `<repo>/.agents/handoffs` and every checkout's `.handoffs` as gitignored symlinks
    to it. `git clean -fdx` deletes ignored files, which removes the links but never
    anything under `.git` (reproduced with real worktrees). `init`, `track new` and
    `track list` recreate a missing link; nothing writes handoffs anywhere else.
- **Shared paths** (`tracks.sharedPaths` in `shape.config.ts`, already in the schema with
  tests): gitignored data every worktree shares with the main checkout, such as a large
  dataset.
  - Paths are repo-relative and inside the repo. The schema refuses absolute paths, `..`
    segments and trailing slashes.
  - `track new` creates the symlink `<worktree>/<path>` → `<main>/<path>` (the main
    checkout's path, which may itself be a symlink). Missing parent directories in the
    worktree are created.
  - If `<main>/<path>` doesn't exist, `track new` skips it with a printed note. It never
    creates shared data.
  - If `<worktree>/<path>` already exists (the path is tracked, or was created by hand),
    `track new` refuses and says so: a shared path must be gitignored, never tracked.
  - `.handoffs` is always shared, without being listed.
  - Before touching the filesystem, `track new` checks the list as a whole: duplicates and
    overlapping entries (`data` with `data/large`) are refused, as is any entry that is, or
    lies under, `.handoffs` or `.git`. The schema already guarantees each entry is normal.
- **CLI surface** (implemented by `init` and `tracks`, called by `skills`):
  - `mshape init <name>`
  - `mshape skills sync` (refresh `.agents/skills` from the installed package)
  - `mshape track new <name>`, `mshape track list`
  - `mshape track current`: the name only on stdout, exit 1 outside a track. A directory
    named like a track is not enough: the directory must be a worktree git has registered
    for this repository (`git worktree list`), on branch `track/<name>`. Otherwise it exits 1
    and says which condition failed. `trackOf` in `src/core/layout.ts` is only the naming
    convention.
  - `mshape track rm <name> [--force] [--keep-handoff]`, defined below.
- **`track rm` safety:**
  - Without `--force`, it refuses if the worktree has uncommitted or untracked changes, or
    if `track/<name>` has commits not in `main`. It says which, and touches nothing.
  - `--force` overrides only those two refusals. It discards that worktree's uncommitted
    changes and deletes its unmerged branch, and the command says so before doing it.
  - **Never deleted, with or without `--force`:** the main checkout, other tracks'
    worktrees, branches or handoffs, the state directory itself, and anything a shared path
    points at. Removing the worktree removes the symlinks, never their targets.
  - **Branch:** deleted when merged into `main`, or with `--force`; otherwise kept.
  - **Handoff:** deleted by default; `--keep-handoff` keeps it.
  - **Order:** check everything first; then remove the worktree, then the branch, then the
    handoff; then `git worktree prune`. If a step fails, stop, report what was removed and
    what remains, and exit non-zero. Running `rm` again finishes the job.
- **Handoff format** (`monkeyshape-iqf.7`; owner `tracks`, consumer `skills`):

  ```md
  # Track: <name>
  Status: stub | active
  Queue: bd ready --label track:<name>

  ## Charter
  ## State (<date>)
  ## Lessons not yet promoted
  ## Traps
  ## Messages
  ```

  A stub has `Status: stub` and an empty charter; `/track` then interviews the human.
- **Package layout:** templates in `template/`, skills in `skills/<name>/SKILL.md`; both ship
  in the npm package. `init` copies `skills/` wholesale, so the `skills` track can add files
  without coordinating.

## Tracks

| Track | Charter | Beads | Acceptance |
|---|---|---|---|
| `init` | `mshape init`: template, toolchain, beads, state directory, skills install and its check; the CLI end-to-end test | `iqf.1`, `iqf.2`, `iqf.3`, `iqf.17`, `iqf.13`; `iqf.14` with the maintainer | A temp repo from `init` passes its gate; the CLI end-to-end test runs in the gate |
| `tracks` | `mshape track new / list / current / rm`, including shared paths, verified `current` and the `rm` safety rules above; the handoff format and stub | `iqf.4`, `iqf.5`, `iqf.6`, `iqf.7` | Each command tested against real git worktrees, including every `rm` refusal and a failure partway through; the handoff format is parsed in a test |
| `skills` | The five skills: `roadmap`, `milestone` (with grooming and gardening), `track`, `handoff`, `review-pr`; and the conventions for adopters: `docs/workflow.md` and the README quick start | `iqf.8` to `iqf.12`, `iqf.15`, `iqf.16` | Each skill uses only the CLI surface above; the refs check passes on them; the maintainer runs `/milestone` on this repo for milestone 2 |

`iqf.13` (the CLI end-to-end test) waits on `init` and `tracks`, and can land early.
`iqf.14`, the **milestone acceptance**, waits on `iqf.13` and all five skills, and closes only
after the maintainer has started a repo with `init` and run the whole loop on it. The `track`
and `handoff` skills wait on the handoff format. Everything else can start now.

## Decision points

- **Claude Code and `.agents/skills`** (`iqf.3`), **decided 2026-10-29:** Claude Code loads
  project skills only from `.claude/skills/<name>/SKILL.md`; `.agents/skills/` is the
  cross-agent convention that Codex and others read. Skills live in `.agents/skills/`, and
  `init` commits a **relative** symlink `.claude/skills` → `../.agents/skills`. Relative,
  because git stores the link text: it then resolves inside every clone and track worktree,
  where an absolute link would point back at one machine's main checkout. The `init` track
  confirms Claude Code follows the symlinked directory and records the decision in
  DECISIONS.md with the test that enforces it.
- **When `init` and `tracks` both work:** the maintainer tries them for real before the
  skills are polished; what breaks becomes `process` beads.

## Deferred, with reasons

- The remaining starter rules (`monkeyshape-hh2`), the agentic layer (`monkeyshape-v56`),
  `mshape validate` (`monkeyshape-97o`): no consumer needs them before the next repo exists.
- Adopting monkeyshape in an existing repo (`monkeyshape-36f`): learned better after one repo
  is born the new way.
- Selectable policy bundles (`monkeyshape-8h4`): no outside adopter yet.

## Spend

None: no model calls in this milestone's code.
