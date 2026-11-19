# Milestone 6: the loop in any harness, and between tracks without relays

**2026-11-19.** Once tracks start, this plan is frozen, except that an approved divergence is
appended under "Amendments" with its date, what changed, why, and who approved it.

## Why this milestone

The loop is language-neutral since 0.6.0, but it still runs in one harness, and between
tracks it still runs through the human.

- **Claude Code is woven into the core.** Session identity is `CLAUDE_CODE_SESSION_ID` and
  `CLAUDE_PID` (`src/cli/main.ts`'s `caller`); hooks exist only as `.claude/settings.json`
  (`src/core/hooks.ts`); skills are reached through the `.claude/skills` link
  (`src/core/layout.ts`); live notices go over Claude Code's undocumented socket, matched
  against `~/.claude/sessions/<pid>.json` (`src/core/notices.ts`). 15 files under `src/`
  name Claude Code. The maintainer starts the Rust repo next, in **Codex**, as soon as the
  loop automation and Codex support are in (2026-11-19); it can't start before.
- **Tracks coordinate through the human.** Milestone 5's retrospective
  (`notes/2026-11-19-milestone-5.md`, Retrospective; #141's first comment) found, across
  every track and reviewer: the human relayed every merge; all five reviewers polled CI; "#N edits your
  file" messages written by hand were mostly noise while messages before a PR were the most
  valuable; `track pr` refused an answer split over two pushes (`gyd`); handoffs restated
  `gh`, `git` and `bd` on every PR event and went stale in minutes.

Both change the same skills, hooks and mailbox, and the loop's fixes must be
harness-neutral anyway, so they are one milestone (the maintainer, 2026-11-19). It comes
before `validate` and the agentic layer because a real repo waits on it.

Milestone 5 closed with 0.6.0 (#140); its plan and retrospective are
`notes/2026-11-19-milestone-5.md`.

## Goal, and how we'll know

1. **A neutral floor.** `mshape prime` loads the loop in any harness: PRIME, registration
   and unread mail, one command, run by a hook where a harness has one and by the agent
   where it doesn't. A session's identity and registration are mshape's, naming the
   harness; mail is pulled by command; PRIME and the skills name no harness.
2. **A harness interface, with Claude Code refactored into the first adapter.** An adapter
   delivers its harness's files (hook config or extension), says where skills are found,
   identifies the session running a command, says whether a registered session is live,
   and pushes a notice. `shape.toml` lists a repo's `harnesses`; `init` and `sync` deliver
   each. Claude Code behaves as on 0.6.0.
3. **Codex and pi adapters.** Codex first (critical path); pi on the frozen interface,
   which it must fit unchanged, as Python did in milestone 5.
4. **Notices are mechanical and opt-in.** `mshape msg watch` turns a PR merging, a bead
   closing, CI finishing on a head and `main` going red into ordinary mail, pushed live by
   the recipient's harness where it can.
5. **PRs and review without relays.** `track pr` names other tracks' files in the PR body and
   mails their owners; `mshape review post` mails the track; `track pr --wait` mails the
   reviewer the head and its CI run. An answer split over pushes isn't refused, and `--wait`
   records CI during review.
6. **Handoffs and the smaller fixes.** A handoff records what no command shows. The skills
   name the mechanisms of goals 4 and 5 instead of asking agents to message. The gate's test
   stages report counts; `track list` stops flagging filed and blocked beads; the open
   process bugs (`jhz`) are fixed.

**Acceptance on real data:**

- **The Rust repo in Codex.** The maintainer's Rust repo (a Cargo workspace, private) is born
  with `mshape init --pack rust --harness codex` from 0.7.0, and its first track runs in
  Codex to a merged PR: session start loads the loop, mail from another session arrives
  (live while idle, if Codex allows; else at the next prompt), `track pr` pushes and
  notifies, and one review round goes through the handshake. Recorded as counts and
  outcomes in the closing PR, never its content. This takes over milestone 5's Rust birth.
- **Claude Code unchanged.** This repo and both adopters' scratch clones: every check
  outcome, every hook's output and a live notice as on 0.6.0, except what this milestone
  changes, each line of difference explained.
- **No relays.** From 0.7.0 to the boundary, the maintainer counts the merges, review
  postings and CI results they still had to tell a session about. The closing PR lists
  each with the reason; the target is none.
- **The interface held:** `codex` and `pi` PRs change nothing in `src/harnesses/harness.ts`
  after the freeze, or each change is an amendment saying why Claude Code and Codex missed it.
- **pi:** the adapter passes its scripted test on a born repo (a real pi session in a test,
  pi 1.5.2 on this machine). A real repo's track in pi is deferred until a pi user
  arrives, by the maintainer (2026-11-19).

**Release:** 0.7.0 as soon as goals 1, 2, 4 and 5, Codex (goal 3) and the skill text are
merged: `z1u.1`–`.6`, `.8`, `.10`–`.12`, `dco`, `lql` (`z1u.15`'s dependencies). The
Rust repo starts from it. pi and the rest of goal 6 follow in 0.7.x. Publishing is the
maintainer's.

## Non-goals

- **A green `main` by mechanism** (`7kw`: a merge queue, required up-to-date branches):
  with many agent PRs, neither fits (the maintainer, 2026-11-19). `main` going red now and
  then is accepted and fixed; the cure is communication, and goal 4's watch on `main` says
  when it happens. Deferred.
- **Cursor and other harnesses; Windows.** No consumer.
- **A monkeyshape daemon or broker.** Mail stays files under the git common directory;
  notices go through each harness's own mechanism. A poller hosted by a harness's own
  extension (pi) is fine.
- **Codex's app-server or pi's RPC mode as the way sessions run.** An ordinary interactive
  session in a track worktree must work; a harness's control protocol may be used to deliver
  a notice, never required to run the loop.
- **Moving the mailbox into a harness** (Codex threads, pi sessions): the mailbox is the
  durable source of truth; a notice only names a message, and only `mshape msg read` marks
  it read (`src/core/mail.ts`).
- **A real repo's track in pi:** deferred by the maintainer until a pi user arrives.
- **The Python repo's birth:** the maintainer's to schedule, outside this milestone.
- **CI under a minute (`3q2`), a command to move the pin (`cyz`), a command for the
  amendments PR (`3a5`):** no track here needs them.
- **`validate` (`97o`), starter rules (`hh2`), the agentic layer (`v56`), Effect (`rrn`),
  ty's coverage (`8il.18`):** later goals; see the roadmap.

## Where we are

| Area | Today (0.6.0) | After |
|---|---|---|
| Harnesses | Claude Code only, fused into the core | `claude-code`, `codex`, `pi` adapters behind `harness.ts` |
| Files under `src/` naming Claude Code | 15 | the Claude Code adapter's only |
| Session identity | `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID`, hook stdin | each adapter's `identify`; registry records the harness |
| Loading the loop | `bd prime` + `msg register` + `msg inbox` as three Claude Code hooks | `mshape prime`, hooked or run by the agent |
| Live notices | Claude Code socket (`claudeCodeNotifier`, the one `Notifier`) | one `Notifier` per adapter |
| Learning a PR merged, CI ended, `main` red | the human relays; reviewers poll | `mshape msg watch`, as mail |
| "#N edits your file" | written by hand | `track pr`, from the plan's File owners table |
| Review handshake | messages by hand, by habit | `review post` and `track pr --wait` send them |
| Open process beads | 17 (`bd list --label process`) | each fixed, deferred with a reason, or closed |

## What changed since milestone 5, and why

- Milestone 5 shipped as 0.6.0 (#140). Its acceptance closed at this boundary: both adopters
  migrated green (#137), the interface held, this repo on `mshape gate`. The Rust repo's
  birth moves here (`z1u.16`), in Codex; the Python repo's is the maintainer's to schedule.
- Its retrospective (#143) became the epic `jhz`; the harness adapters are `dlz`. Both are
  served by this milestone's epic, `z1u`.
- The maintainer, 2026-11-19: Codex and pi both built; Codex accepted on the Rust repo, pi's
  real-repo acceptance deferred; `7kw` deferred, `main` occasionally red accepted.
- Research by an agent for the maintainer (2026-11-19), on what Codex and pi offer natively,
  is below under "Harness facts". It is design input, unverified on this machine (codex-cli
  0.170.0 and pi 1.5.2 installed 2026-11-19), and the tracks verify each fact on the installed version first.

## Interfaces the tracks share

### Layout and modules

As the packs were in milestone 5:

| Path | What | Owner |
|---|---|---|
| `src/harnesses/harness.ts` | The interface: types only; its own arch module, depending on schemas only | `harness` |
| `src/harnesses/<id>/` | An adapter's pure part: file rendering, identity from env and hook input, notice text | `harness` (`claude-code`), `codex`, `pi` |
| `src/adapters/harnesses/<id>.ts` | Its I/O: liveness, the `Notifier` | as above |
| `src/harnesses/index.ts`, `src/adapters/harnesses/index.ts` | Registries: additions only, one line per adapter | `harness` |
| `shape.toml`'s `[arch.modules]` | `harnesses/harness.ts` and `harnesses` modules, as `packs` | `harness` |

The core never imports an adapter, only `harness.ts`. `src/core/notices.ts` keeps what is
neutral (registrations, `planNotice`, the notice line); what is Claude Code's moves.

### The harness interface (`z1u.1`)

`harness` drafts it with `codex` by message, from Claude Code's code and Codex's facts;
`harness` freezes it, and `main` records the freeze as an amendment. A draft of what it holds,
for the tracks to settle, not a spec:

- `id` (`claude-code`, `codex`, `pi`), and the `files` it delivers: path, content, and a
  delivery kind (`owned-key`: a key in a file the repo also edits, as Claude Code's `hooks`
  in `.claude/settings.json`; `whole`: a file monkeyshape writes, as an extension).
- `skills`: where the harness finds them, and whether a link is needed (`.claude/skills`
  for Claude Code; `.agents/skills` read natively by Codex and pi, reported).
- `identify(env, hookInput)`: the session running this command, or nothing.
- `invoke(skill)`: how a human starts a skill in that harness, for text `mshape` prints
  (`/track` in Claude Code).
- `live(registration)` and `notify(registration, line)`: in the adapter's I/O half, the
  existing `Notifier` generalised.

### `mshape prime` (`harness`, `z1u.2`)

| Case | Result |
|---|---|
| a session start, hooked, at a track's worktree | prints PRIME (as `bd prime` today), registers at the track, lists unread subjects |
| run by the agent in a harness with no hook | the same; registration uses `identify`, else is skipped with one note |
| `bd` missing | PRIME's text still prints, from `.beads/PRIME.md`, with the note `bd prime` gives today; exits 0 |
| outside every address (a scratch dir) | PRIME only; no registration, no note about mail |
| run twice in one session (compact, clear, resume) | one registration; the second run prints and registers idempotently |
| stdin is a terminal | never waits on it (`jhz.3`) |
| a repo whose `shape.toml` doesn't load | PRIME and mail still print; the config's error is one line |

### Session registry (`harness`, `z1u.2`)

A registration gains `harness` and an optional `endpoint` (whatever that harness's notifier
needs: a socket, a thread id); `pid` becomes optional.

| Case | Result |
|---|---|
| a 0.6.0 registration (no `harness`) | read as `claude-code` |
| two sessions of different harnesses at one track | both registered; a notice goes to each by its own notifier |
| a session id two harnesses could both have written | keyed by harness and session: no collision |
| a registration whose harness this repo no longer lists | still notified while live; pruned when its adapter says gone |
| a registration whose harness this `mshape` doesn't ship | skipped with a note naming it; never pruned by guess |
| `identify` finds nothing (a plain terminal) | no registration; the note names no harness, says what was missing |
| a session forked or resumed with a new process (pi, Codex) | the registration's endpoint is updated, not duplicated |

### Harness selection (`harness`, `z1u.4`)

`shape.toml`: `harnesses = ["claude-code"]`, the default when absent. `init --harness <id>`
(repeatable) writes it.

| Case | Result |
|---|---|
| no `harnesses` key (every 0.6.0 repo) | `["claude-code"]`: sync and check unchanged |
| `["codex"]` | `.codex/hooks.json` delivered; no `.claude/` written |
| a harness id this `mshape` doesn't ship | fails at config load, naming the shipped ids |
| a harness removed from the list | sync removes the files it wrote (by its manifest, `iwf`), never the repo's own keys |
| an owned file edited by hand | `sync` check fails naming the file and the command, as hooks today |
| two harnesses listed | both delivered; `prime` runs from whichever starts the session |

### Notices (every adapter)

A notice only names a message: sender, subject, id, and the command to read it. Never the
body. Where a harness can only inject user-role input (reported for `codex queue`), the line
says it is mail from another session, not an instruction from the user. A notice that can't
be delivered changes nothing: the mail waits and the next prompt's inbox lists it.

### Harness facts (design input, to verify)

Reported 2026-11-19 by research for the maintainer, from the harnesses' docs and source; not
yet run here. Each track verifies its harness's facts on the installed version before
building on them, and reports what differs in its first PR.

- **Codex (codex-cli 0.170.0 here):** project hooks in `.codex/hooks.json` (`SessionStart` with startup, resume,
  clear, compact and fork sources; `UserPromptSubmit`; `SessionEnd`), JSON on stdin with
  `session_id` and `cwd`, stdout added as developer context. `CODEX_THREAD_ID` in tool
  commands' environment; a thread id and a session id differ for forks.
  `codex queue --thread <id> --message <text>` queues user-role input to a thread, waking
  an idle loaded thread; `--resume` for an unloaded one; acceptance isn't processing.
  `codex app-server` (JSON-RPC over stdio or a unix-socket WebSocket) can `turn/steer` an active
  turn, but may not reach a standalone CLI session. Reads `AGENTS.md` and `.agents/skills`.
- **pi (1.5.2 here):** TypeScript extensions from `.pi/extensions/`, loaded once the project
  is trusted. `pi.on("session_start" | "session_shutdown", ...)`,
  `ctx.sessionManager.getSessionId()`.
  `pi.sendMessage({customType, content, display}, {triggerTurn, deliverAs: "steer"})` adds a custom (not user) message, waking an idle session or steering
  a busy one. No socket of its own: an extension opens one. Third-party extensions doing
  this (pi-cross-session, pi-intercom, pi-messenger, mitsuhiko's agent-stuff `control.ts`)
  are references to read, not dependencies (a new runtime dependency is the maintainer's).
  Reads `AGENTS.md` and `.agents/skills`.

### Watches (`notices`, `z1u.8`)

`mshape msg watch pr <n> | bead <id> | ci <sha> | main`; `mshape msg unwatch ...`;
`mshape msg watch` lists this address's watches. Stored per address under its mail
directory. Checked, for the whole repo, when `mshape prime` or `mshape msg inbox` runs, at
most once a minute across sessions (a stamp under the mail directory), through `gh` and `bd`.
An event becomes one message from the sender address `mshape` to the watcher, then a notice.

| Case | Result |
|---|---|
| a watched PR merges | one message: "#N merged", with its merge commit; the watch is removed |
| a watched PR closes unmerged | one message saying so; removed |
| a watched bead closes | one message with its close reason; removed |
| CI on a watched head ends | one message: pass or fail, the run's URL; removed |
| `main`'s CI fails on a new head | one message per failing head, naming the merged PR; the watch stays |
| `main` goes green again after red | one message; the watch stays |
| an event already sent | never sent twice, across sessions and restarts |
| two addresses watch one PR | each gets its message |
| `gh` or `bd` can't run | no message, no watch lost; one note, at most once an hour |
| every session idle | checked at the next prime or inbox anywhere; a harness poller may check sooner |
| a reply to `mshape` | fails: `mshape` takes no mail; says to message the track instead |
| the watcher's track removed | its watches go with its mailbox (`track rm`'s unread-mail rule applies) |
| watching a PR or bead that doesn't exist | fails at watch time, naming it |

### File owners (`prs`, `z1u.10`)

`track pr` reads the table under "### File owners" in `plan/MILESTONE.md` on the base it
gates: `| Path | Track |`, paths as globs, the first matching row wins. This is that table.
`src/cli/main.ts`, `shape.toml` and `test/` are every track's, so no row names them: a test
belongs with its code, and a conflict there is settled as it comes.

| Path | Track |
|---|---|
| `src/harnesses/harness.ts` | harness |
| `src/harnesses/codex/**` | codex |
| `src/adapters/harnesses/codex.ts` | codex |
| `src/harnesses/pi/**` | pi |
| `src/adapters/harnesses/pi.ts` | pi |
| `src/harnesses/**` | harness |
| `src/adapters/harnesses/**` | harness |
| `src/core/hooks.ts` | harness |
| `src/core/layout.ts` | harness |
| `src/core/skills.ts` | harness |
| `src/adapters/skills.ts` | harness |
| `src/core/notices.ts` | harness |
| `src/adapters/notices.ts` | harness |
| `src/core/scaffold.ts` | harness |
| `src/core/sync.ts` | harness |
| `src/adapters/init.ts` | harness |
| `src/schemas/config.ts` | harness |
| `schema/**` | harness |
| `template/AGENTS.md` | harness |
| `src/core/mail.ts` | notices |
| `src/adapters/mail.ts` | notices |
| `src/core/watch.ts` | notices |
| `src/adapters/watch.ts` | notices |
| `src/core/tracks.ts` | notices |
| `src/adapters/tracks.ts` | notices |
| `src/core/gate.ts` | notices |
| `src/adapters/gate.ts` | notices |
| `src/core/release.ts` | notices |
| `src/adapters/release.ts` | notices |
| `src/core/trackPr.ts` | prs |
| `src/adapters/trackPr.ts` | prs |
| `src/adapters/reviews.ts` | prs |
| `src/core/conventions.ts` | prs |
| `skills/track/**` | prs |
| `skills/review-pr/**` | prs |
| `skills/handoff/**` | prs |
| `template/.beads/PRIME.md` | prs |

| Case | Result |
|---|---|
| the PR touches only its own track's files | no line, no mail |
| it touches another track's file | the body's "Other tracks' files" line names file and track; that track gets one message |
| a later push touches the same set | no new message |
| a later push adds a file of a third track | one message to that track only |
| a path no row matches | not anyone's: no mail |
| an owner that isn't a running track (`main`, a removed track) | named in the body; mail only to a live mailbox |
| no plan, or no File owners table | no line, no mail, one note |
| a malformed row | that row skipped, named in a note; the rest apply |
| the diff removes lines `main` gained since the merge base, in another track's file (`jhz.4`) | refused, naming file and lines: rebuild the squash on the merge base |

### Review handshake (`prs`, `z1u.11`)

| Case | Result |
|---|---|
| `review post` on a track's PR | mails the track: the review's link, one line per finding with its severity |
| `review post` LGTM | mails the track "LGTM"; the review worktree is removed (`1vc`) |
| `track pr --wait` on a PR with a posted review | when CI ends, mails the reviewer: the head, the run's URL, its outcome |
| no reviewer registered yet | the message waits in `review-<track>`'s mailbox for the session that registers there |
| a review answered in two pushes (`gyd`) | the second isn't refused while the first's answer is unposted; the reviewer gets one message per push |
| pushes before any review (`gnv`) | allowed; no mail to a reviewer, who hasn't started |
| `--wait` during review | records CI in the Gate section, as outside review |
| a track's PR from a branch not `track/<name>` (`3lo`) | `mshape review` finds the track from the PR (body or author's worktree), keeps `review-<track>` |
| `main`'s `shape.toml` doesn't load (`zw9`) | `mshape review` still opens the worktree, linking no shared paths, with a note |
| a review of a PR from no track (`review-<n>`) | `review post` mails no one; the author is told by the PR |

### Who builds what in skill text

`prs` owns the track, review-pr and handoff skills and PRIME (`z1u.12`). `harness` makes
PRIME and the skills name no harness (`/track` becomes the skill's name, with `invoke` where
`mshape` prints it): it edits those files in its PR and sends `prs` one line, as below.

**Editing another track's file:** ownership says who to tell, not who may edit. A track
whose change needs another's file edits it, says so in its PR body and sends the owner one
line naming the file and why (from `z1u.10` on, `track pr` does this itself). A decision
that touches several owners' files goes to `main` first, which names one owner.

## Tracks

| Track | Serves | Charter | Acceptance |
|---|---|---|---|
| `harness` | goals 1, 2 | The interface, drafted with `codex` and frozen; `mshape prime`; the registry and identity; Claude Code as the first adapter; `harnesses` in `shape.toml`, `init --harness`, sync per harness (`iwf`); PRIME and skills harness-neutral | This repo and both adopters' scratch clones as on 0.6.0; tables `prime`, registry and selection as tests |
| `codex` | goal 3 | The Codex adapter: hooks, identity, skills, a notifier through `codex queue` (or app-server); `init --harness codex`. Starts at once on the draft and reviews it | A born Rust repo's scripted Codex session loads the loop, registers, gets a notice, opens a PR; then the Rust repo (acceptance) |
| `pi` | goal 3 | The pi adapter: the extension, a socket it owns, `pi.sendMessage`; built on the frozen interface, unchanged. Starts at the freeze | A born repo's scripted pi session gets a notice while idle; `harness.ts` unchanged |
| `notices` | goals 4, 6 | `msg watch` and its table; `--reply-to`; `track list` and `track rm` fixes; gate test counts; the release fixes and 0.7.0's preparation | The watch table as tests; a watch on this repo's own PRs delivers through a real merge |
| `prs` | goals 5, 6 | File owners and the owners notice; the review handshake and its table; `jhz.4`; the skill text | Both tables as tests; the handshake run on this milestone's own reviews |

**Beads** (epic `monkeyshape-z1u`; serves `dlz` and `jhz`): `harness`: `z1u.1` interface,
`z1u.2` floor, `z1u.3` Claude Code, `z1u.4` selection, `iwf`, `jhz.3`. `codex`: `z1u.5`,
`z1u.6`. `pi`: `z1u.7`. `notices`: `z1u.8` watch, `z1u.9` reply-to, `z1u.13` (`6ky`, `ag8`,
`2dl`, `jhz.5`, `jhz.1`), `z1u.14` counts, `dco`, `lql`. `prs`: `z1u.10` (`jhz.4`), `z1u.11`
(`gnv`, `gyd`, `3lo`, `1vc`, `zw9`), `z1u.12` (`jhz.2`). The release: `z1u.15`; the
acceptance: `z1u.16`.

**Order:** `harness` and `codex` draft the interface together at once; `harness` freezes it,
then `pi` starts. `notices` and `prs` need nothing to start; `prs`' owners notice is the
first thing that saves this milestone's tracks messages, so it goes first. The release
waits for its beads; the Rust repo waits for the release.

## Decision points

- **The interface freeze:** `harness` and `codex` disagree on a shape: `main` decides if it
  touches no goal, the maintainer otherwise.
- **Codex's notifier:** if `codex queue` can't wake an idle interactive thread, `codex`
  proposes app-server or pull-only for Codex, by message to `main`; whether pull-only is
  enough for 0.7.0 is the maintainer's.
- **A user-role notice:** if a harness can only deliver user input, the wording that marks it
  as mail is reviewed in `codex`'s PR; whether to deliver at all that way is the maintainer's.
- **A poller for idle sessions:** if the acceptance shows mail waiting on idle sessions with
  no prompt anywhere, `notices` proposes a harness-hosted poller; a background process of
  monkeyshape's own is a non-goal.
- **A new runtime dependency** (a pi package, a Codex SDK): the maintainer's.
- **Publishing 0.7.0** is the maintainer's.

## Deferred, with reasons

- `7kw`, Cursor, Windows, a daemon, the Python repo, `3q2`, `cyz`, `3a5`, `97o`, `hh2`,
  `v56`, `rrn`, `8il.18`: see Non-goals.
- pi's real-repo acceptance: the maintainer's, until a pi user arrives.
- `4sa.14`, `4sa.22`, `5iq`, `725`, `ede`: no track of this milestone needs them.

## Spend

None beyond ordinary sessions. A scripted harness test runs no model: it drives the
harness's hooks, extension and queue directly, or is skipped with a note where the harness
needs a model to start.

## Amendments

None yet.
