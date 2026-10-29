---
name: review-pr
description: Use when asked to review a pull request (a number or URL), or to re-review one after its author replied or pushed fixes. Runs the change on real data in its own worktree, probes what it claims to enforce, posts every finding as inline PR comments with a severity, and re-reviews until it can say "LGTM".
---

# Review a pull request

A review is judged by what it **ran and read**, not by what it guessed from the diff. Every
finding carries its evidence: the input that breaks it, a real-data output, or the line of
code it rests on. Read AGENTS.md first: it holds the rules the PR is reviewed against.

**Ground rules**
- **All findings go on the PR**, as comments. Don't fix the PR yourself and don't file
  beads for findings: the author fixes them on their branch.
- **A blocker needs a concrete failing input or a real-data result.** Style never blocks:
  the linter owns style. Everything else is a nit, and says so.
- **One round and a re-review**, then the human decides what is still open.
- Real data and real targets may be read and run freely; anything that spends money past
  the repo's cap, or writes to shared data, needs the human first (see AGENTS.md).

## 1. A worktree for the PR

Review the PR's head in a track of its own, never in your checkout:

```bash
N=<pr number>
gh pr view $N --json title,body,headRefName,headRefOid,files,commits
mshape track new pr-$N          # prints the worktree; links the shared data
cd <that worktree>
gh pr checkout $N --detach && bun install --frozen-lockfile
```

The track's handoff is where a re-review in a fresh chat finds your probes and findings:
write them there as you go. Keep the track until the PR is merged or closed.

## 2. Read the diff

Read the PR body and every changed file. Then go through it for:

- **The invariants it claims.** If a schema, check or test says it enforces something, list
  the inputs that should fail. Those are your probes in step 3.
- **Docs it touches, or should have.** Do AGENTS.md, DECISIONS.md, the skills and the other
  tracks' handoffs still agree with the change? Grep for prose it made stale.
- **The usual misses.** New code outside the gate (a tsconfig `include`, a test glob)? A
  check that a free-text field walks around? A check-then-write that isn't atomic? A path
  that breaks in a worktree, a symlink or a fresh clone? An error message that doesn't say
  what to do?

## 3. Run it

From cheapest to most expensive:

1. **Run what the PR adds**, on real data, in every mode it has. Do the numbers in the PR
   body reproduce? Does each exit code mean what its doc says?
2. **Probe checks adversarially.** Write a throwaway script in the worktree that builds
   inputs that should be rejected, one variation each, from a real artifact where there is
   one, and prints what comes back. **A bad input that passes is a finding**, and the
   probe is its evidence. Keep it for the re-review; never commit it.
3. **Run the real workflow** when the claim is about what it produces end to end.

Don't rerun the gate on the first pass if the PR body shows it green; do on a re-review whose
fix touched code.

## 4. Post on the PR

Post **one review**, inline comments anchored to the head commit, built as a JSON file so
the quoting survives:

```bash
# review.json: {commit_id, event: "COMMENT", body, comments: [{path, line, side: "RIGHT", body}]}
gh api repos/{owner}/{repo}/pulls/$N/reviews --input review.json -q .html_url
```

Anchor each comment to a head-commit line that is in the diff; a finding with no such line
goes in the review body. Each comment opens with a **bold one-sentence finding** and its
severity (blocker or nit), then the evidence, then a suggested fix. The body says what was
run and what came out, the blockers, the nits with no line, and what looked good. Use
`COMMENT`: GitHub refuses approve and request-changes on your own account's PR.

Then tell the human in a few lines: what you ran, each finding and its severity, the review
link. **Stop and wait** for the author.

## 5. Re-review

When told the author responded, read every reply, the new commits and the fix diff
(`gh pr view $N --comments`, `gh api repos/{owner}/{repo}/pulls/$N/comments`).

1. "Fixed" is a claim: update the worktree to the new head and rerun the probes and the
   real-data runs.
2. Look for what the fix opened: a new unchecked field, the mirror case of a new check.
3. **Pushback is an argument, not a refusal.** If it holds, say so and drop the point; if it
   doesn't, answer with evidence.
4. Reply in the threads, then post a short summary review: what was re-verified, what is
   resolved, what is still open. Tell the human.

**When every blocker is resolved and verified, say "LGTM"** explicitly, on the PR and to
the human, with any remaining nits beside it. Never while a blocker is open or unverified.
Merging is the human's call. Once the PR is merged or closed: `mshape track rm pr-$N
--force` (the probes are untracked, and `--force` says what it discards).

Review this skill when a blocker it should have caught reaches `main`.
