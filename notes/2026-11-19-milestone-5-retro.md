# Milestone 5 retrospective: working between tracks

2026-11-19. Every track (`config`, `binary`, `packs`, `rust`, `python`) and reviewer
(`review-<track>`) was asked by mail how working together went: messages, collisions,
reviews, handoffs. `packs` and `binary` handed off mid-milestone and answered first, before
handing off; those earlier answers weigh most, their later sessions' follow-ups less. On the
handoff question alone, the later sessions weigh more: they are the only ones that read an
inherited handoff. What was agreed became `monkeyshape-jhz`, taken in milestone 6 with the
harness adapters (`docs/roadmap.md`).

## What several agreed on

1. **Two green PRs merged in turn turned `main` red three times** (#109, #112, #124; every
   track, four of five reviewers). The cure is testing the merge itself: the maintainer's
   merge-queue or up-to-date setting (`7kw`). Meanwhile: LGTM only on a head merged with
   `main`, with CI on that head; shared add-only files split into one file per pack; a
   shared file split before its budget.
2. **Track and reviewer messaging each other directly worked, and belongs in the skills**
   (every reviewer; `rust`, `python`, `config`). The reviewer messages the track after
   posting, with the link and one line per finding; the track answers with its head, its CI
   run (not "CI green") and each finding's test; a review starts only on the human's
   `/review-pr`; one push per review round.
3. **"#N edits your file" notices were mostly noise; messages before a PR were the most
   valuable** (`packs`, `binary`, `rust`, `python`, `config`). `track pr` knows the diff and
   the ownership: it can name other tracks' files in the body and notify their owners, so
   agents write only messages that need a decision.
4. **Opt-in notices would replace the human's relays** (every track and reviewer): a PR
   merged or a bead closed, to tracks that asked; CI finished on a reviewed head, to the
   reviewer (all five polled CI); `main` went red.
5. **A handoff should hold what no command shows** (both handed-off sessions, `config`,
   `python`): a decision, local-only work and why it waits, a trap; the charter rewritten
   when a decision changes it; before stopping. Updates on every PR event restated
   `gh`, `git` and `bd`, went stale in minutes, and saved nothing.
6. **`track pr`'s refusal during review is right but blunt** (`binary`, `review-binary`,
   `rust`, `python`, `config`, `packs`): `--wait` should still record CI; a reviewer waiting
   on another PR shouldn't block pushes (`gnv`).
7. Smaller: the gate's test stage should report pass, skip and fail counts (two reviewers;
   a suite skipped silently in CI until #131); a decision touching several owners' files
   goes to `main` first, which names one owner (`python`: one pin took six messages).

Single-source bugs filed under `jhz`: `bd close` with a `TODO(<id>)` still in code;
`bd update --notes` replacing notes; `msg register` hanging in a terminal; a squash reverting
lines `main` gained. The planning session's own lesson (`config`): check a plan's facts
against the code before they become a task.

## The answers

### packs (before its handoff)

packs' retro on working with other tracks (session 2026-11-18, PRs #98 #101 #105 #111).

1. Communication
- Best part: rust as a live consumer. The pack.ts draft went from rust's 7 needs (18:25) to my draft (18:26) to its review (18:27) to its Rust pack wired on my branch and probed on a real 3-crate workspace (18:37). That loop found every serious defect in my PRs before or alongside review-packs: rules/syntax on every lib.rs (#98), sync appending a duplicate [workspace.lints] that broke cargo (#105), init vendoring the npm tarball into a Rust repo (after #111). A consumer probing on real data beat any fake in my tests.
- Weak part: volume of notices. Most of my mail was "#N edits your file" one-liners (binary #100, #113; config #96, #99; rust #102; python #108). Each was correct and short, but they arrive mid-step, each needs a read, and almost none needs action. Two of mine were noise: heads-ups to review-packs about pushes to #105 before any review had started (the maintainer flagged it).
- Better: make "edits your file" mechanical. track pr knows the diff and the plan's ownership: it could list other tracks' files in the PR body and send each owner one notice itself, marked as a notice (no action expected), so agents only write messages that ask for a decision. Keep decision messages (Divergence:, Decide:) as they are: main approved each of mine within minutes.

2. Stepping on each other
- Conflicts were small and settled by an explicit "second to merge integrates" agreement: config and I on stage names and PACK_STAGES (#99 vs #101), binary carrying bunPath into the loader I had moved out of workspace.ts (#100 after #98). That rule worked whenever it was said out loud; say it by default in the skill.
- The two red mains were both "green alone, red together": #99 x #104 (localBin's return type) and #102 x #105 (ruleCases.test.ts past its 1200-line budget, half the lines mine). Neither showed as a git conflict. Avoid: a merge queue or require-up-to-date (7kw); and split shared, additions-only files before they reach a budget (rust's #112 did it after the fact). I knew ruleCases was at 1189 when I added cases and didn't act.
- Waiting: rust waited on #98's merge for its first PR, and 8il.10 waited on binary's 8il.6. Neither stalled anyone, because each could build on a local branch or a scratch merge. A scratch merge of another track's branch (rust did it on mine) is a good pattern to name in the skill.
- CI queueing behind other tracks' pushes made track pr --wait report green before ci had started (7ya, config fixing). Five tracks pushing in the same minute is now normal.

3. Telling other tracks how a PR affects them
- I did both. Before the PR: the interface draft to rust, the stage-name agreement with config, init --pack's layout to rust and python. Those were the most useful messages I sent, because the others built in parallel on a shape that then didn't move. After the PR was up: "#98 edits your files" to config, README to binary. Cheap and fine.
- During review it went worse: I took rust's findings and main's test request straight into #105 while it was open, pushing twice before any review, and messaged the reviewer each time. Blockers must go in, as the maintainer says, so freezing the PR isn't the answer, but there's no rule yet for who hears what (gnv).
- Improve: decide interfaces by message before the PR (worked every time); notify owners after the PR is up, mechanically (above); and before review, batch findings from other tracks into one push with one line to the maintainer, not a stream of heads-ups.


### binary (before its handoff)

binary's retro (PRs #100, #104, #113, #122).

1. Communication between tracks.
Messages worked best when they named a file and an action:
- config on #99's gate.ts spawning process.execPath;
- packs on Integration.fix ("set fix where localBin finds no Bun");
- rust's and python's reports of refs/unknown-script on the shipped skills, which moved 8il.7 to the front of my queue.

The weaker ones:
- **Crossed messages.** python and I each proposed who pins CI's MSHAPE_VERSION within a minute of each other (my offer vs their "leave template/packs/python alone").
- **One question asked twice.** python asked "does 8il.7 cover mshape's own messages?" though my earlier message to them said so; their reviewer needed it in writing for #115.
- **A correction of my own.** I told packs #113 split ruleCases.test.ts, then had to send a correction after #112 split it first.

Better: a message that answers another one names it (`--reply-to <id>`), so a thread reads as one, and crossed messages show up as crossed.

2. Stepping on each other.
- **Red mains:**
  - #99 x #104: #104 changed localBin's result from string to argv-or-Integration while #99's gate.ts read a string. Both were green alone and main went red until #109.
  - #115 x #120 (two [coverage] tables in shape.toml, then #124).
- **Content conflicts:**
  - #112 and #113 both split ruleCases.test.ts for its line budget, differently. I dropped mine.
  - #121 and #122 edited the same template/AGENTS.md line.

To avoid them:
- **Merge order:** GitHub's "require branches to be up to date before merging" (or a merge queue) would have caught both red mains before merge, at the cost of a rebase per merge.
- **Exported signatures:** when a PR changes an exported function's signature, track pr could grep the other open PRs' diffs for its callers and say so. I'd have messaged config before #104 if it had.
- **Budgets:** a file at its line budget is a shared hazard; whoever splits it first should say so by message.

3. Telling other tracks how a PR affects them.
I did both:
- **After the PR was up** (#100, #113, #122): one line per owner naming the file and why.
- **Before** for 8il.7's template CI: I told config while the work was on a local branch, and config built the CI pin in parallel. That was the better of the two. After-the-fact notices were mostly "your next merge may conflict", which is less useful than a chance to shape the change.

Improvement: the plan's ownership table is machine-readable enough that track pr could list "files of other tracks this PR edits" in the body and send each owner the one line itself. I wrote that by hand every time.

4. Waiting on merges.
- **I learned of every merge from the maintainer typing it:** "100 merged", "109 merges in", "121 merged". #122 was waiting on #121, and I was idle until told.
- **I messaged packs only to fix an order:** "#122 waits on your #121".

An automatic "PR #N merged" message, sent to tracks that asked for it (`mshape msg watch 121`, or a dependency named in the PR body), would have:
- let me continue #122's answer the moment #121 merged;
- let me rebase binary-next onto main without a prompt;
- told config when #104 landed, the change that broke their #99.

Plain "merged" broadcasts to everyone would be noise. Only subscribed tracks should get it.

5. Me and review-binary.
It went well: concrete probes, a blocker I would not have found (MSHAPE_LAUNCHED inherited by nested mshape, #113), and re-reviews within minutes. The session persisting across my PRs helped: it knew the history.

Awkward points:
- **A review answered in two pushes deadlocked.** On #122 I pushed the part that could land (7caf7a3), then the rest after #121 merged. track pr refused the second push while the reviewer was live with nothing posted on 7caf7a3, and the reviewer had to post a "status review" to unblock me. I filed this as a process bead.
- **track pr --wait refuses during review.** It refused on #104 and #113, so I polled gh by hand and the Gate section stayed stale.
- **No way to say an answer is still coming.** A reviewer can't tell "I'm still answering" from "re-review now" except by message. A track pr --answering flag, or a PR label, would carry it.

My first PR had a reviewer from the start, so no gap there.


### config


Retro: config (one session from start to finish, no handoff; 8il.1, 8il.3, 8il.2 plus 336, ba8, xbk, t6j, 6k8, 7ya, w2d, e22).

1. Communication. Worked: short messages that asked one decision with a proposal, answered within minutes. The stage-name question with packs (#99 vs #98: "adopt tsc/biome/bun-test or say which"), and the localRules removal ("who removes it after 8il.11?", answered "your flip PR, go-ahead to edit engine/local.ts"). Divergences to main got same-minute answers ("8il.2 in two PRs"). Didn't: a lot of FYI traffic ("#N edits your file X") that rarely needed action. I sent many myself. Each cost a read and a check for collisions, and only a few found anything (#98's workspace.ts conflict, python's CI being recognised by track pr). Main also corrected itself twice in a row on 8il.2's acceptance ("step 3 moves to main", then "stays yours", then "there are two adopters, not three"). One message after checking would have saved three. Better: send FYI only when the recipient must act or their next merge will conflict, and name the lines. Facts about the plan (adopter count) should be checked before they become a task.

2. Stepping on feet. The red mains were real and costly: #109 (#99's gate.ts read localBin's old string result after #104 changed it) and #124 (#115 and #120 each added a [coverage] table to shape.toml). Each took a fix PR, messages to three tracks, and a wait. Twice a red main also blocked my own push: #123 via a stale main checkout, and #132 via packs' TODO naming a closed bead, both main's gate, not my diff. Avoid: GitHub's "require branches to be up to date" or a merge queue would have caught all three; it is a settings change, not process. Short of that, a shared config file (this repo's shape.toml) should be appended to inside existing tables, and the second merger rebases and reruns the gate before merge. A merge-time gate run on main, not only per PR, would at least catch it the moment it happens.

3. Telling others how a PR affects them. I did it after the PR was up, by message, one line per file and why (#96, #99, #110, #137). It worked: each owner knew which lines they'd collide on. Before the PR is up is better only for an interface choice (stage names). That I asked as a decision, and it was better that way: packs adopted the names before either PR merged. Improve: say it in the PR body (I did) and message only owners whose open work touches the same lines.

4. Waiting on merged PRs. Yes, mildly: several times I learned a PR merged only from the maintainer typing "N merged" here, or noticed when a fetch showed it. I never messaged anyone just to say one merged. An automatic "PR #N merged" to tracks that asked would have helped in two cases: main-fix PRs (#109, #124, #135), where every track was blocked until merge, and dependency PRs (#130 for 8il.2, #134 for the acceptance rerun). For ordinary PRs, no: I only need my own.

5. Reviewer messaging. Mostly smooth: findings inline, a one-line message when up, LGTM by message, and fast turnarounds of minutes. Awkward:
   - I refreshed #99's body during its review without a heads-up. The maintainer flagged it, and I saved it as a memory.
   - track pr refused --body-only and --wait after an answer had been pushed, while the reviewer was live (filed 336, fixed in #99).
   - --wait misreported CI three ways (t6j queued, 6k8 already finished, 7ya check not yet created), which made "CI green" claims to the reviewer unreliable until #110 and #118.
   - Once track pr's gate refused my answer because main was red (#132 waiting on #135): the reviewer had to be told "fixed, can't push".

6. Handoff. I updated State on every PR opened or merged, and when a decision changed the plan (the divergence, the localRules decision), roughly fifteen times. It was the skill's rule plus my judgement: the session was long, and messages kept arriving that changed what was next. Worth it for decisions and conditions, such as main's conditions on 8il.2 and packs' go-ahead, which I'd otherwise have only in this chat. Not worth it for the list of merged PR numbers, which git and gh already know. No fresh /track ever read it, since I never handed off, so this is a guess: a fresh session needs what's open (PR, local branch), what it waits on, and decisions or conditions not in code. Rule I'd suggest: update State when what's next or a condition changes (a PR opens, a decision lands, a blocker appears or clears), not on every merge. Keep it to those items.


### rust


One session ran rust from start to done; no handoff happened.

1. Communication
- Worked best: reviewing an interface before it was built. I sent packs Rust's seven needs before their pack.ts draft existed (2026-11-18 18:25); they answered each within minutes (draft 249905d, then 29ca7e6), and the freeze happened on #102 with pack.ts unchanged.
- Also worked: probing another track's open PR with my real code on a local scratch merge, and sending a reproducible failure. #98: the rules engine parsed .rs with oxc (rules/syntax on every lib.rs); fixed in 96432a0 before merge. #105: five dotted or inline forms of Cargo's lint tables made sync write a duplicate table that cargo refused; fixed before merge, and I reran the probe on each fix.
- Didn't work: my own status lines. The maintainer had to ask "did you message them to message you when the refactor merges?" (I hadn't), and later "do you want a review on 114? that's super unclear" ("ready for review" read as if a review would just happen). Better: when a PR needs the human, say "please start /review-pr N" as the first line, not a description of the PR's state.

2. Stepping on each other's feet
- Two of the three red mains were half mine: #112 (ruleCases over its 1200-line budget: #102 x #105) and #124 (two [coverage] tables in shape.toml: #115 x #120). Each PR was green alone, and each merged within a minute or two of the other. A third, milder case: #110 merged a test asserting the Rust stage names fmt/test while my rename to cargo-fmt/cargo-test (config's own ask) was unmerged, so my next rebase broke on config's test.
- How to avoid it: the only thing that catches all three is testing the merge result before it lands, i.e. GitHub's "require branches to be up to date" or a merge queue (the maintainer's setting). Short of that: shared, additions-only files split per contributor, as #112 did for ruleCases (a pack's cases in test/packs/<id>/ruleCases.ts); and for shape.toml, a check or habit of grepping main and open PRs for the same table before adding one. That grep is in my handoff's lessons.

3. Telling other tracks how a PR affects them
- Both. Before: pack.ts needs, the lints delivery divergence to main (approved within a minute). After, as the skill says: one line per edited file of another track (#102: config's schema; #120: shape.toml and gate.test.ts; #125: scaffold.ts/scaffold.test.ts). The "after" lines were cheap and nobody pushed back.
- Before-the-PR was clearly worth more: it changed designs (pack.ts's edge `from` any file, PackLoad.findings, table delivery) instead of reporting conflicts.
- Improvement: `track pr` knows the PR's files and the plan's ownership; it could print, or send, the "this PR edits your file" line itself. I wrote five of those by hand.

4. Waiting on merged PRs
- Yes. I missed #115's merge entirely (the maintainer: "115 should be merged in a while ago"), and #115 was the thing my next change waited on. Many messages I received were only "#N merged" (packs: #98, #101, #105, #111, #116, #121), each because I'd asked for one.
- An opt-in "PR #N merged" would have replaced all of those. Better still, tie it to beads: notify a track when a bead its open bead depends on closes (8il.15 depended on ae4, 465 and 8il.7; I learned each closed by message or by checking).

5. Me and my reviewer
- Went well: review-rust messaged a short summary with each review; I messaged on each push. Five PRs through three rounds at most, each finding with a regression test.
- Awkward: (a) track pr refused to push a fix main needed (#102 merged with main failed ruleCases after #101) because the reviewer hadn't posted yet; I held it and told the reviewer by message. Right in principle, but a "this answers main, not the review" path would help. (b) `track pr --wait` during or after review recorded nothing on a head CI had finished on (monkeyshape-6k8, fixed in #110), so two PRs' Gate sections said pending while CI was green. (c) The human had to start every review; I never knew whether one was coming until a message arrived.

6. My handoff
- Updated about fifteen times: at each PR open and merge (the skill's rule), and after most messages that changed the plan (my judgement). Cost was small, a scripted State rewrite each time. No fresh /track ever read it, so its value this milestone was zero, and insurance.
- One real bug: I wrote "## State (2026-11-18, evening)" and `track list` marked the track invalid; caught and fixed.
- Rule I'd keep: update at PR open and merge, and before stopping; skip mid-review churn. Keep State short: what is open, what each open thing waits on, and the one command to run next.


### python


Retro from the python track. One session ran the whole milestone, with no handoff: PRs #108, #115, #129 and #131; beads 8il.16, 8il.17, zfk and 88a; 8il.18 waits on the Python repo.

1. Communication

Worked:
- **Messages sent before I built something were the most useful by far.**
  - packs told me how delivery would work (copy for ruff, the pointer check as my finding kind, #105) before I'd written the base config. That shaped the design.
  - packs told me where the template goes (#111) before I needed it.
  - My ty divergence ("no extends, so a sync-owned table") went to main before I built it, and was approved and recorded within about 15 seconds.
- **Questions with one owner got one answer.** Example: "does 8il.7 cover mshape's own messages?" to binary. Its yes was specific (the files and literals), so I could answer #115's nit without reading binary's branch.

Didn't:
- **One decision took six messages and three PR-body edits:** who pins `MSHAPE_VERSION` in the Python template's CI.
  - I told #115's reviewer it was 8il.7's job.
  - binary said no: a follow-up after 465.
  - config then said its next branch reads the pin, and suggested I copy it.
  - binary withdrew its offer.
  - I took it.

  Nobody was wrong. The CI files had three owners (config: the common CI; binary: install.sh and the pin; python: the pack layer), and each of us answered from our own slice.
- **Duplicated work: #116 and #115 built the same `--from` refusal in `src/cli/main.ts`, in parallel.** I only learned of it from packs' message after both PRs were up. One message before opening #115 ("I'm about to change init's tarball handling in your main.ts") would have saved it.
- **Duplicated messages:** main and rust both told me about the ruleCases split (#112), minutes apart.

Better: a decision that touches several owners' files goes to main first, which names one owner, and is then said once.

2. Stepping on each other's feet

- **#115 × #120 was mine.** Each PR added its own `[coverage]` table to shape.toml. Each was green alone; together, main didn't parse, and #124 fixed it. It's now a lesson in my handoff: "add to the existing table, never a new header".
- **ruleCases (#112):** #108's merge with main put test/core/ruleCases.test.ts at 1274 lines (budget 1200). #108 had to wait for #112 before it could even push its merge.
- **Every pack PR conflicted on the same additions-only lines.** In #108 and again at #115: `src/packs/index.ts`, `src/adapters/packs/index.ts`, `src/schemas/config.ts` (one table per pack) and the generated `schema/shape.schema.json`. Each was trivial (keep both sides), but each one forced a manual merge with main before CI would run. #108 had to merge 32 commits that way.

How to avoid them:
- **Red mains:** a merge queue, or "require up to date before merge". The cost is a CI rerun per merge (about 2 min).
- **The repeated registry conflicts:** files where a pack adds its own file (one file per pack, collected by glob), rather than a line in a shared one.
- **The generated schema:** check it in CI rather than committing a regenerated copy that conflicts every time.
- **Line budgets:** split a shared file before it nears its budget, as packs said.

3. Telling other tracks how a PR affects them

- **I did both.** Before the PR: the ty divergence, to main. After the PR was up: an "edits your file" one-liner to each owner (packs, config and binary for #108; packs, config, binary and rust for #115).
- **The after-PR one-liners mostly changed nothing.** Two did matter:
  - The one telling binary that #115 depends on 8il.7: binary then knew about the skills' bun lines.
  - The one telling rust about `{{module}}` and init delivering base configs.
- **The before-the-PR messages are the ones I'd keep.**

Improvement: `track pr` lists the other tracks' files the PR touches, in the body, and sends each owner one marked notice itself. Agents then write only messages that need a decision or an action. This agrees with packs and binary.

4. Waiting on PRs that had already merged

- **Yes, every time.** The maintainer typed each merge to me: #108, #111, #112, #115, #122/#123, #129 and #131.
- **For #112 I ran a background loop polling `gh pr view` every 60 s.** The maintainer told me first anyway.
- **An opt-in "PR #N merged" message would have helped for three kinds of wait:**
  - #112: main was red, so my push waited on it.
  - #105 and #111: interfaces I was about to build on (copy and table delivery, `init --pack`).
  - #122 and #123: the last two things 8il.17 needed.

  Each would have saved a human relay and a poll. I'd use it as `mshape msg watch <pr>` from a bead's "waits on" notes.

5. Me and my reviewer

- **It went well.** review-python existed when I opened #108, and its messages always named the next step ("merge main, then LGTM").
- **Awkward 1: `track pr --wait` refused during the review.** That was after its push had already gone through, so I polled CI with raw `gh api`. The `gh` here is old (no `pr checks --watch`, no `headRefOid`).
- **Awkward 2: the reviewer reported "CI never ran on 71a2eb0".** It had; it started after they looked.
- **Awkward 3: an LGTM on a PR that conflicts with main is conditional.** #108's waited on #112, then on my merge-and-move.

Suggestion: `track pr --wait` should still wait for and record CI during a review, while refusing to push. The Gate section would then never go stale, and the reviewer could read CI's result there.

6. The handoff

- **I updated State about 10 times:** when each PR opened or merged (the skill's rule), and when I became blocked on something new (#112, #111, 8il.7), by my own judgement. I also added lessons.
- **Each update was cheap,** a scripted edit of one section.
- **No fresh `/track` ever read it.** I can't say what one would have needed; its value is unproven here.
- **Much of State duplicated bead notes.** 8il.17's notes ("what's left: 8il.7, the CI pin") and 8il.18's ("waits on the Python repo") said what State said.
- **A small snag:** `.handoffs` is a symlink outside git, so my first `git add .handoffs/python.md` failed. Nothing in the skill says not to commit it.

Rule I'd suggest: per-bead "what's left" lives in the bead's notes (one home). State says only which PR is open, what the track waits on, and its next bead. Update it when a PR opens or merges and before you stop, not on every new blocker.


### packs (follow-up, later session)


Retro: packs, from the session that ran #116 to #136 (2026-11-18 evening to 2026-11-19).

4. Merge notices. I never waited on a PR that had already merged: the maintainer told me "merged" in chat each time (#116, #121, #126, #130, #134, #135, #136). But I sent three "landed" messages whose only content was a merge: rust after #116 (ae4) and #121 (465), which blocked their 8il.15, and binary after #130 (8il.10), which unblocked their execPath rule. An opt-in "PR #N merged" notice to tracks that asked would have replaced all three, better as "bead X closed" (what they were actually waiting on). The bigger miss at merge time was mine, not a notice: closing q0z after #134 merged turned main's gate red, because code on main still said TODO(monkeyshape-q0z) (#135 fixed it). A post-merge step that greps for TODO(<id>) before closing a bead would have caught it; a merge notice wouldn't.

5. The reviewer (review-packs). It went well: six PRs, each round answered within minutes, every finding came with a probe I could rerun and a suggested fix, and three findings were real bugs I'd have shipped. Awkward, all on #126: I pushed the round-1 fix, then merged main locally and ran track pr again; it refused (review in progress, nothing posted on the new head). I had already written on the PR and to the reviewer that the merge was up, and had to correct both. Lesson: a review round gets one push, with any merge of main in it. After the LGTM, my unpushed local merge sat on track/packs; my reset to drop it was denied by the permission classifier, and it only went away when the next replay reset the branch. The refusal itself was right; the skill could say "one push per round" up front. I never saw a reviewer session end.

6. The handoff. I updated State about a dozen times, mostly because the track skill says to when a PR opens or merges, plus when a decision or divergence landed (main's approvals, the maintainer's no-ports decision). What this fresh /track actually used from the inherited handoff: State's "Next, first" (the bead ids, and the note to ask binary about sums before building 465), the Traps (pack.ts frozen; ruleCases near its budget; never name adopters on GitHub; track pr --wait reporting CI early) and Probes (where the adopter clones come from). The Charter I read once, and it later went stale: main had to point out that it still said to port the adopters' rules after the maintainer dropped that. The per-PR State updates mostly restated what gh, bd and track list already show; they cost little each but saved nothing. The updates that mattered recorded what nothing else holds: a local branch with unpushed work (packs-next, the unpushed merge), a decision and its source, a trap learned. Suggested rule: update the handoff when something can't be recovered from git, bd or gh (local-only work, decisions, traps), rewrite the Charter the moment a decision changes it, and before stopping; drop "update State on every PR open/merge".


### binary (follow-up, later session)


From this session (the one that finished 8il.22 and 8il.20, PR #138).

6. The handoff

How often: I rewrote State about eight times in one session:
- once when the first docs commit existed but no PR did;
- after the 8il.20 commit;
- when #138 opened;
- after pushing a merge of main;
- after answering review;
- at LGTM;
- at merge;
- when the track was done.

Why: mostly the skill's text ("update State when a PR opens or merges, so a crash loses nothing"), which I read broadly as "whenever the PR's state changes". Two updates were my own judgement and the most useful ones:
- the maintainer's decision to hold 8il.22 for one whole PR, not a partial one;
- that 8il.22 had committed but unpushed work on the branch.

Neither lives anywhere else. git shows an unpushed commit but not why it waits.

Worth the cost? About half. Each update is cheap: the handoff is a symlink, so there's no commit, only a few tokens. But the head SHAs, "CI running", "LGTM, macOS queued" and "reviewer messaged" are things gh, git and `mshape track list` already say, and they went stale within minutes. A crash would have lost nothing that `gh pr view` doesn't show.

What the fresh /track needed from the inherited handoff:
- **State, Done:** what had merged, and which bead's work was finished despite the bead staying open. 8il.20's "helper done, rule left" saved me re-auditing every spawn.
- **Next with its blockers and owners:** it said what to watch for. bd's dependencies said the same, more reliably. The handoff's "waits on the templates 8il.15, 8il.17" was already half stale, and bd was right.
- **Traps.** `msg inbox` needs `</dev/null`. `bun run release` packs its cwd. The bunPath trap. "This repo pins dev". All used or relevant.
- **Charter:** read once, to know the track's done line.
- **Not needed:** the long Done list of earlier PRs, beyond knowing they merged.

What should the rule be:
- **When State changes:** update it when something changes that no tool shows, such as:
  - a human's decision;
  - work that exists only locally (an unpushed branch, a next branch) and why it waits;
  - a blocker's real state when it disagrees with bd;
  - a trap just learned.
- **At the end:** update it at a merge and when stopping (/handoff).
- **What not to record:** heads, CI, review state, or anything `gh pr view`, `git log` or `track list` derives. If something like "PR open, in review, LGTM" is worth seeing at a glance, `track list` can print it.

So the skill's line would become something like: "Update State when it holds something no command shows: a human's decision, local-only work, a lesson; and at merge and at handoff. Never copy what gh, git or bd say."

Additions to the earlier answers (this session):
- **Collisions:** #137 (config) and #138 both rewrote docs/adopting.md and test/integration/harness.ts, the consumer test's fixture, in parallel. adopting.md was this track's file. Per the plan, the editor messages the owner. This session got no message about it before the reviewer found the conflict. It may have gone to the earlier session's inbox, so I can't say it wasn't sent. The merge was easy, because both made the same TOML conversion, but the work was done twice. A one-line "I'm converting adopting.md to TOML" would have saved one of us.
- **My own slip:** `bd update --notes` replaced a bead's existing notes without asking. I recovered them from `bd history --events`. `--append-notes` is the safe default for an agent. That's worth a line in PRIME.md, or a trap.
- **Review:** the reviewer's message ("conflicts, 2 nits", with the asks) was enough to act on without opening the PR first. Its follow-up, "if your probe used the installed mshape, rerun", worked the same way the other direction.


### review-config


Retro from review-config: one chat reviewed every config PR. #96, #99, #110, #118, #123, #128, #132 and #137 came from track/config; #109 and #124 came from fix/ branches.

1. Messaging the track directly

It worked well, and it is why rounds were fast: #110 went through three rounds and #137 through three, each in well under an hour. What worked was a fixed shape.
- Reviewer to track: "Review of #N is up: K blockers, M nits", with the link and one line per finding, ending "message me at review-<track> when it's fixed".
- Track to reviewer: "#N: <what> fixed at <sha>, CI green".

Awkward:
- "Replied in the threads" sometimes arrived before the replies were visible (#99). The reviewer should read the thread, not trust the message.
- "CI green" in a message is a claim. Twice it was still running (#110, #118), and I waited on CI myself.
- The config track's heads-ups were useful and should be standard: "I edited the body during your review" (#99, from track pr --wait) and "pushing the merge with main now" (#99).

For review-pr: after posting, send the author the summary line and the link, and ask to be messaged at review-<track>. Verify CI and the thread yourself; a message is a pointer.
For track: when answering, message review-<track> with the new head sha. Send a heads-up on any push or body edit while a review is open.

2. Edge cases hit

- A track's PR from a non-track branch: #109 (fix/gate-localbin) moved me from review-config to review-109, because the address comes from the branch name. The maintainer had to correct me. Filed: monkeyshape-3lo.
- mshape review on the PR that fixes main's config: #124 (main's shape.toml defined [coverage] twice) failed in mshape review itself, which loads the main checkout's config. I reviewed it in a worktree made by hand. Filed: monkeyshape-zw9. The track-pr side was #128.
- track pr refused a push while the review was open: #132's fix waited about 5 minutes on #135. The local fast gate failed beads/todo-closed on a TODO naming q0z, which #134 had closed, on main. CI was green, because CI has no bead database. So the local gate and CI disagree on beads: a closed bead's TODO reaches main unseen and then blocks every other track's push. Either `bd close` should refuse while a TODO names the bead, or CI should see beads.
- A body edit during review (#99), let through by 336's fix: not a finding, since the head didn't move.
- Not hit: a session ending mid-review (the review lives on the PR, so a fresh chat can pick it up), two reviewers on one track, and a first PR with no reviewer yet (#96 was fine).

3. Changes from elsewhere reaching the PR mid-review

Often, and three times it broke main:
- #99 conflicted after #98 merged. By the tracks' own agreement it then had to move to pack.stages, a code change to the gate's core, which needed another full round.
- #99 and #104 broke main's tsc (fixed by #109).
- #115 and #120 broke shape.toml (fixed by #124).
- #110 and #111 had a semantic conflict that CI's merge ref caught before merge.
- On #118, main had moved 30 files since the branch base, including ci.yml, so I merged it locally and reran the affected tests.

How it should work:
- Require branches to be up to date, or a merge queue: main's process bead.
- Until then, write into review-pr: before LGTM, if main moved since the head's base, merge origin/main locally and rerun the tests the PR touches.
- Compare real-data probes against origin/main, never the main checkout. Mine was stale once (#110) and gave a false difference.

4. Waiting

I waited on CI far more than on messages, which arrived promptly. The macOS binary-run sat queued long enough that the maintainer told me twice to skip it (#124, #137). The skill should say which jobs gate an LGTM (check, the whole gate) and which don't (binary-run on macOS).

A merge notice would help with cleanup, not with reviewing. I've accumulated review worktrees for #96, #99, #109, #110, #118, #123, #128, #132 and #137, and never knew when to run `mshape review rm`. A message to review-<track> on merge, or `mshape review rm` offered when a PR merges, would fix that.

5. Other

- The most valuable probes ran the compiled release binary (`bun run release pack`, then .release/mshape-<platform> in a born repo or an adopter copy). Both #123's and #137's blockers were visible only that way. Unit tests and the Bun CLI passed, because the compiled mshape can't import a TypeScript config. Suggest a real-data probe row in AGENTS.md: "The compiled mshape: when a PR touches what the binary runs (CI templates, config loading, migrate), run it from bun run release pack."
- Other probes that found real defects:
  - building an awkward valid input from the PR's own claim: #118's expression-named matrix jobs, #99's stage names with '/';
  - adversarial schema-versus-loader corpora (#96);
  - round trips: migrate's wide config compared before and after (#132).
- My own misses, both corrected: I didn't check who opened #109 (the address move), and I used the stale main checkout as the baseline (#110).


### review-binary


Reviewer of track binary, one chat across #100, #104, #113, #122 and #138.

1. Messaging the track directly: it worked well and was fast.
- After each review I sent `binary` the link, each finding in one line, and "message review-binary once you've pushed". It answered with the new head and a summary, usually within minutes: #104 5b3a87b to 7a821eb, #113 fa725b1 to 29eadba. Each message named the head, which is what I need to re-review.
- Awkward: review-pr doesn't say to message the track. On #100 the maintainer had to ask me to. Write it into review-pr step 5: after posting, `mshape msg send <track>` with the link, the findings in one line each, and "message review-<track> with the new head once pushed". Step 6: the LGTM goes to the track by message too. The track skill should say the mirror: after pushing answers, message review-<track> with the head and what changed.
- Their messages also carried things I'd otherwise miss: #122 "lands after #121 (maintainer's call)", and the installed mshape being rebuilt from main during #138.

2. Edge cases
- track pr refusing a push while my review was in progress (#122): the push guard blocked `daa156e` because I was live with no review on `7caf7a3`. But I wasn't reviewing, I was waiting on #121. I posted a status review only to unblock it. It was true ("blocker still open, pending daa156e"), but it's a workaround. The guard should block only while the reviewer is actually reviewing that head (`mshape review <n>` could record reviewing vs. waiting), or the reviewer should be able to release it with one command instead of posting a review.
- A blocker that waits on another track's PR (#122 on #121): the fix was a sequencing call for the maintainer, not a patch. The review stayed open across the wait. Worth one line in review-pr: when the fix is another PR merging first, say so on the PR, and re-review after it merges in.
- Session continuity: one chat held review-binary across five PRs, and that worked. Context grows, but each re-review rereads the thread, as the skill says, so a fresh chat could pick up from the PR alone. I didn't hit two reviewers on one track, or a first PR before any reviewer existed.
- Probe gotcha: `mshape msg register` blocks reading hook JSON on stdin. Run by hand in a probe, it hung until a 300s timeout, until I added `</dev/null`. Anyone running a hook's command in a terminal, as the hook's own note says to, hits it. It should not wait on a TTY, or should time out.

3. Other tracks' changes reaching the PR mid-review: this happened on four of the five PRs.
- #100: #98 merged during re-review. #100 went CONFLICTING and GitHub ran no checks on the new head at all. I found out only because check-runs for that head was empty.
- #100 (first round): the branch deleted the `rust` track's Cargo-lints amendment from plan/MILESTONE.md, because the author squashed with `reset --soft origin/main` after main had moved. Nothing but review caught it. `track pr` could refuse a diff that reverts lines main gained after the merge base, in files the track doesn't own.
- #122: main itself was red for a while (two `[coverage]` tables, fixed by #124). My "main vs PR" probe compared against a broken main.
- #138: #137 merged mid-review and conflicted in two test fixtures. The maintainer told me; nothing in the loop did.
- How it should work: review-pr should say "before LGTM, the head contains origin/main or merge-tree is clean, and CI ran on that head". It's in my memory, not the skill. And re-fetch origin/main right before each main-vs-PR probe.

4. Waiting: yes, mostly on CI.
- I polled check-runs in shell loops on #104, #113, #122 and #138: gh 2.4 here has no `pr checks --watch`, and my first try returned at once.
- I learned #137 had merged from the maintainer. #121's merge came by the track's message.
- Automatic notices would have helped, in this order:
  - (a) CI finished on a head I'm reviewing, with the result;
  - (b) main moved and my PR is now conflicting or behind;
  - (c) the PR merged, the least useful, since by then I'm done.

5. Other
- macOS runners stayed queued for long stretches on 2026-11-19. The maintainer told me to judge on the finished jobs and say macOS wasn't awaited. That belongs in review-pr beside the CI step.
- No denylist is configured on this machine: every `mshape review post` printed "nothing was scanned". I kept the adopter's name out by hand. Either configure one, or have `review post` refuse without one, rather than note it.
- Each code blocker became a regression test that I ran against the old head: #100 x2, #104, #113, #122, #138's rule cases. Where the old head couldn't load the new test (new exports), I reverted the fix on the new head instead. review-pr could name that as the accepted fallback.


### review-packs


Retro from review-packs: one chat reviewed all of packs' PRs, #98 to #136 (#98, #101, #105, #111, #116, #121, #126, #130, #134, #135, #136).

1. Messaging the track directly

It worked well, and it was the main channel. After each posted review I sent packs the link and one line per finding; packs replied at review-packs with the new head and "answered on the PR". Every round started within minutes, and I never had to poll the PR for replies.

Awkward:
- Heads-ups before any review existed. On #105, packs messaged me twice ("updated", then "one test added") before the maintainer had asked for a review, then "ready for review ... when the maintainer asks". I had already created a worktree from the third message before reading its last sentence, and had to remove it. Write into the track skill: message review-<track> only after a review exists on the PR. Write into review-pr: a review starts on the maintainer's /review-pr, never on a track's message.
- A placeholder link. On #126 I messaged packs before capturing the review URL, so the message said "pullrequestreview-..." instead of the link. In review-pr: post, then message with the URL that `mshape review post` printed.
- A correction message. On #126 packs said "merged with main", then sent a correction a minute later: the head was the fix alone. It was harmless, but "message the head SHA, and nothing you haven't checked" would avoid it.
- Worktree lifetime. I kept the review worktree after LGTM, waiting for a sign the review was over. The maintainer said to remove it at LGTM; that is filed as bead monkeyshape-1vc, and the skill should say it.

2. Edge cases

- Pushes before or during a review: #105's head moved twice before the review started. `mshape review <n>` moves the worktree and prints the previous head, and that was all I needed.
- Session continuity: not hit. This one chat held every round from #98 to #136 at about 30% context.
- `track pr` refusing a push mid-review, status-only reviews, two reviewers on one track, a track's first PR before any reviewer: none hit.
- Foreseeable: a fresh reviewer chat picking up mid-round has the thread, but not which probes were scratch-only. The review body's "What I ran" section is what makes the pickup possible, so keep that section mandatory.

3. Changes from other tracks or main reaching the PR mid-review

Yes, three times, each a red main found through a PR's CI:
- #105: CI red only on the merge with main. Main itself was red: #99's gate.ts against #104's new localBin result, each green alone. #109 fixed it.
- #111: main red again: ruleCases.test.ts at 1222/1200 lines after #102 and #105 each added cases. I added it to bead monkeyshape-7kw as a second occurrence.
- #135: main red on beads/todo-closed, because q0z closed when #134 merged while its TODO was still in the code.

What helped: comparing this repo's and the adopters' output against the PR's merge base, not today's main; building a merged worktree (main plus PR head) to run typecheck and the touched tests; and running main's CLI alone to prove a red CI wasn't the PR's. Branch protection or a merge queue (7kw) would remove the whole class. Until then, a reviewer's LGTM should say whether main itself is green.

4. Waiting

I never waited on merges. I waited on CI several times, with background loops on the check runs. An automatic message when CI finishes on a PR's head would replace those loops. A message when main's own CI goes red would have caught all three incidents in item 3 before a reviewer tripped over them. The maintainer also set two exceptions: no waiting on CI for a one-line comment change (#135), and none on queued macOS runners.

5. Anything else

- Four of the five blockers I raised were the same class: something passes green while checking nothing. #98: a .js file in sources was skipped while `rules` counted it. #105: sync silently deleted `[[...]]` sections, then the check said current. #126: the advice for root-level crates, once followed, left Cargo.toml in no module, so arch passed over a forbidden edge. #130: a shape-rule in a language no pack claims had passing cases and was listed, but never reported. None was caught by the PR's own tests; each was caught by a real-data probe. The probe "what does this do on input it can't see?" belongs in review-pr's step 4 as a standing question.
- Real tools beat fakes. Running real cargo, the pinned ast-grep and real `init` births found what the unit tests' fixtures couldn't.
- Old-head regression runs: for nits, the new test sometimes failed on the old head for an incidental reason (a renamed field or message) before reaching the bug (#130, #134). For blockers the step was always meaningful. The skill could say that for a nit, a CLI probe of the finding is enough evidence.
- Adopter probes were cheap, about a minute each, and always byte-identical or explained. Keep them on every PR that touches a check.


### review-rust


review-rust reviewed #102 (three rounds), #112, #114, #120 and #125, from one chat throughout.

1. Messaging the track
- It went well. Each answer from rust came as a message naming the new head, where each reply was, and which test failed on the old head (#102 rounds 2 and 3, #125). That made re-review mechanical: read the message, move the worktree, run each named test on both heads.
- The best example: during #102's first review, rust messaged that the PR merged with main (after #101) failed ruleCases. They held the fix until my review was posted ("no need to report it as a finding"). That stopped a push from landing under my review, and kept a known issue out of the findings.
- Awkward: telling the track that a review was posted was ad hoc. I sent `mshape msg send rust` by hand after every `mshape review post`, with the link and counts. Nothing in review-pr says to.
  - review-pr should say: after posting, message the author's track with the link, the blockers and the nits.
  - Better, `mshape review post` could send that message itself.
  - track should say: when answering, message the reviewer with the new head and, for each finding, the regression test's name and where the reply is. That is what rust did.
- The command changed mid-milestone, from `bun run --silent mshape msg ...` to `mshape msg ...`. Both worked here; the skills' text has to follow.

2. Edge cases
- Track's first PR (#102): `mshape review 102` created review-rust and moved this session there. It worked first time.
- Pushes during review: none landed under me, because rust held commits until I posted, as above. That is a convention, not a check. track pr could refuse to push to a PR whose latest review is older than an unanswered message to the reviewer, but the convention held fine here.
- Session ending, two reviewers on one track, a status review to unblock a push: I didn't hit any of these. The PR thread held everything a fresh chat would need, since every finding, reply and re-verification was on it.
- No denylist was configured on this machine, so `mshape review post` scanned nothing in any of my reviews. It printed a note each time, and I kept the text generic by hand. If the denylist is meant to be the check, a missing one could warn louder, or fail for a repo that is public.

3. Changes from main reaching a PR mid-review: yes, and they caused the two most important events.
- #101 merged during #102's review and made `packs/rust/member-lints` live. Following that check's advice then broke cargo. That was a new blocker in round 2, caught only because I followed the message as written on a real workspace.
- #102 and #105 each passed CI and merged a minute apart. Together they pushed ruleCases.test.ts over its 1200-line budget and turned main red, fixed by #112. I had confirmed #102 contained main at LGTM, but #105 merged after.
- From then on, I merged main into the review worktree myself before every LGTM: #114 was 12 behind, #120 2 behind, #125 15 behind. On #125 the merge changed the verdict. 8il.7 and 465 had landed, so 8il.15's acceptance was met on the merge but not on the head, which the PR body still said was waiting.
- Proposals:
  - (a) review-pr step 4: run the PR's tests and the real-data probes on a local merge with main whenever the branch is behind, and say so in the review.
  - (b) The maintainer's call: require branches up to date before merging, or use a merge queue, so a green PR means a green main.

4. Waiting
- I never waited to learn a track had answered: its messages arrived within minutes, and each said what to look at.
- I did wait on CI before every LGTM, polling with `gh run watch` in the background. One watch broke because the installed gh has no `--json` on `pr checks`.
- I never learned a PR had merged except by looking.
- An automatic message to the reviewer would help for:
  - CI finishing on the PR's head (pass or fail), to replace the polling;
  - the PR merging or closing, as the cue for `mshape review rm` (not needed while I removed the worktree at LGTM), and to know the next PR is due.

5. Anything else
- CI's log only shows `mshape gate`'s one line per stage. On #120 I couldn't tell from CI whether template.test.ts's toolchain block ran or skipped, so I reran it locally. The gate could print the test runner's skip count, or keep the full log as an artifact.
- Two probes found every blocker, and both are worth writing into review-pr:
  - valid input the new check must pass, on real data (#102's include!, cfg_attr and cargo-fuzz false failures);
  - following each check's own advice, as written, on a real repo, until the check passes (#102's member-lints).
- The 95% rule held: one cosmetic edge case, a repo named `std` (#125), stayed out of the findings, and the review said why.
- `binary-run (macos-latest)` was cancelled at 15 minutes with no failed step on #112, while main's same job passed in 16s. It's runner noise worth knowing, so a reviewer doesn't block on it.


### review-python


review-python reviewed #108, #115, #129 and #131: four PRs and eight review rounds, all ending in LGTM.

1. Messaging the track directly
- It worked well. Each answer from python named the new head, what each finding's fix was, and what it tried beyond my probes. For example, on #108 it extended ruff-exclude to per-file-ignores ALL, and it found a second open() miss. So each re-review started at once, with no polling.
- Awkward: the first time (#108), the human had to tell me to message the track. review-pr says "Stop and wait for the author" but never says to tell the author. Write into review-pr step 5: after posting, `mshape msg send <track>` with the review link and its blockers in a line, and ask for a message to review-<track> when answered.
- A race: python wrote "71a2eb0 pushed, CI green". I queried the Actions API, found no run for that SHA, and posted "CI has not run". The run started after I looked, and I had to correct it on the PR. Write into the track skill: the answer message names the CI run (the URL `track pr --wait` records), not just "CI green". Write into review-pr: if the head has no run yet, wait or re-query before saying so.

2. Edge cases
- I ran `mshape review 115` from inside the old review worktree (head a76f5b9), after main had changed shape.toml. It failed with `shape.toml: Expected array at ["refs"]["docs"]` and moved nothing. Run from the main checkout, it worked. That suggests the old head's code reading the newer shape.toml, but I didn't confirm it. Either `mshape review` should always run main's code and config, or review-pr should say to run it from the main checkout. Not filed yet.
- `mshape review rm` while my shell was in that worktree left the next command failing ("Working directory ... no longer exists"). review-pr could say to run `review rm` from the main checkout.
- Main turned red under a PR in review: #102 and #105 merged a minute apart, each under the budget, and together they pushed test/core/ruleCases.test.ts to 1222 lines (budget 1200). #108 then couldn't go green until rust's #112 split the file. A check on the merge with main before merging (or merge queue semantics) would have caught it before main.
- No session ended mid-review, I never had to post a review just to unblock a push, and no track had two reviewers.
- Every `mshape review post` printed "no denylist is configured, so nothing was scanned". On a public repo, the scan that AGENTS.md relies on never ran this milestone. Someone should set up the denylist (the maintainer's, since it lives outside the repo).

3. Changes from other tracks or main mid-review
- Twice, a PR went CONFLICTING between my rounds, and the last round was only the merge. #108 conflicted after #102 and #105 merged. #115 conflicted after #116, whose TypeScript-only vendoring guard duplicated #115's own (resolved by keeping #116's), and after #113, whose install.sh turned #115's "Not done" into something the template could do.
- What worked: LGTM only on a head that merges cleanly with main and has CI on that head, and checking that the diff since the last reviewed head is only the merge plus named resolutions. That is my practice and a memory, not the skill. Write it into review-pr step 6: "the final LGTM is on the head merged with main".
- A cross-track nit: on #115, `SYNC_COMMAND` (binary's file) told Python repos to run `bun run`. It was settled by binary saying 8il.7 covers it, and I verified that only in binary's uncommitted worktree, which isn't durable evidence. Better: the owning track comments on the PR or names its bead or commit.

4. Waiting on merges or answers
- I never waited on an answer: python always messaged. The one wait that bit was CI (above). An automatic message to review-<track> when CI finishes on the PR's head would have prevented my false "CI has not run".
- A "PR merged" message would be a nicety. I `review rm` at LGTM anyway, and I only need to know about merges for conflicts, which the track's next message tells me. An automatic "track answered" message isn't needed while tracks message reliably; if anything, `track pr` could send it on each push of a PR in review.

5. Anything else
- `mshape gate` in CI prints stage results only, so the CI log can't show which tests skipped. On #131 I could prove the toolchain suites ran only by reasoning: under CI=true, skipWithout never skips. Before #131 (88a), the Python loader suite, which holds #108's acceptance, silently skipped in CI. The gate's bun-test line should report pass, skip and fail counts.
- Small follow-up PRs (#129 at 3 files, #131 at 10) took one round each. Bigger ones (#108 at about 2000 lines, #115) took three or four, mostly because of merges, not findings.


