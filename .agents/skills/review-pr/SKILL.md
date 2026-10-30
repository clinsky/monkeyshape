---
name: review-pr
description: Use when asked to review a pull request (a number or URL), to re-review one after its author replied or pushed fixes, or to review a follow-up PR that answers an earlier review's findings. Runs the change on real data in a scratch worktree, probes what it claims to enforce, posts every finding on the PR with a severity, and re-reviews until it can say "LGTM".
---

# Review a pull request

A review is judged by what it **ran and read**, not by what it guessed from the diff. Every
finding carries its evidence: the input that breaks it, a real-data output, or the line of
code it rests on. Read AGENTS.md first: it holds the rules the PR is reviewed against.

**Ground rules**
- **The PR is the review's only home.** Findings, evidence, replies and what is still open
  all go on it; nothing about the review is kept anywhere else. A fresh chat re-reviewing
  reads the thread.
- **Don't fix the PR yourself** and don't file beads for findings: the author fixes them in
  the same PR.
- **A blocker needs a concrete failing input or a real-data result.** Style never blocks:
  the linter owns style. Everything else is a nit, and says so.
- **One round and a re-review**, then the human decides what is still open.
- Real data may be read and run freely; spend past the repo's cap, or writes to shared data,
  need the human first (see AGENTS.md).

## 1. A worktree at the PR's head

```bash
N=<pr number>
gh pr view $N --json title,body,files,commits
gh api repos/{owner}/{repo}/pulls/$N -q .head.sha   # the head you review and anchor to
mshape review $N         # detached worktree at that head, shared data linked; prints its path
cd <that path> && bun install --frozen-lockfile
```

Never review in your own checkout. If the review's head and the API's differ, the author
pushed meanwhile: run `mshape review $N` again.

**A follow-up PR** that answers an earlier review: read that PR's thread first
(`gh pr view <earlier> --comments`, and its inline comments as in step 5). Each finding it
claims to answer is a re-review item (step 5), on top of reviewing its own diff.

## 2. Read the diff

Read the PR body and every changed file. Then go through it for:

- **The invariants it claims.** If a schema, check or test says it enforces something, list
  the inputs that should fail. Those are your probes in step 3.
- **Docs it touches, or should have.** Do AGENTS.md, DECISIONS.md, the skills and the
  handoffs still agree with the change? Grep for prose it made stale.
- **The usual misses.** New code outside the gate (a tsconfig `include`, a test glob)? A
  check that a free-text field walks around? A check-then-write that isn't atomic? A path
  that breaks in a worktree, a symlink or a fresh clone? An error message that doesn't say
  what to do?

## 3. Run it

From cheapest to most expensive:

1. **Run what the PR adds**, on real data, in every mode it has. Do the numbers in the PR
   body reproduce? Does each exit code mean what its doc says?
2. **Probe checks adversarially**: throwaway scripts that build inputs which should be
   rejected, one variation each, from a real artifact where there is one. **A bad input
   that passes is a finding**, and the probe's input and output are its evidence on the PR.
   Probes are scratch and are never committed or kept: one worth keeping is a regression
   test, and that is the author's to add (step 4).
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
severity (blocker or nit), then the evidence, then a suggested fix.

- **A blocker in code asks for a regression test** in the PR: one that fails on this head
  and passes once fixed. A blocker in prose (two docs that disagree, a wrong instruction)
  asks for the fix; there is nothing to test.
- **If a check could rule out the whole class**, say so: the PR body's "Class closed by"
  line is where the author answers it.

The body says what was run and what came out, the blockers, the nits with no line, and what
looked good. Use `COMMENT`: GitHub refuses approve and request-changes on your own
account's PR. Then tell the human in a few lines: what you ran, each finding and its
severity, the review link. **Stop and wait** for the author.

## 5. Re-review

When told the author responded, read the thread: every reply, the new commits and the fix
diff (`gh pr view $N --comments`, `gh api repos/{owner}/{repo}/pulls/$N/comments`). The head
you reviewed last is your previous review's `commit_id`
(`gh api repos/{owner}/{repo}/pulls/$N/reviews`). Run `mshape review $N` to move the
worktree to the new head; it prints the previous one too.

1. **"Fixed" is a claim.** For each code blocker, find its regression test and run it on
   both heads. It must fail on the old one and pass on the new:

   ```bash
   git switch --detach <old head> && git checkout <new head> -- <test file>
   bun test <test file>                                   # must fail
   git reset -q --hard && git switch --detach <new head>
   bun test <test file>                                   # must pass
   ```

   A test that passes on the old head doesn't test the bug: that is a finding. For a prose
   blocker, read the fix. Rerun the real-data runs the findings rested on.
2. Look for what the fix opened: a new unchecked field, the mirror case of a new check.
3. **Pushback is an argument, not a refusal.** If it holds, say so and drop the point; if it
   doesn't, answer with evidence.
4. Reply in the threads, then post a short summary review: what was re-verified, what is
   resolved, what is still open. Tell the human.

**When every blocker is resolved and verified, say "LGTM"** explicitly, on the PR and to
the human, with any remaining nits beside it. Never while a blocker is open or unverified.
Merging is the human's call. When the review is over, `mshape review rm $N`: it lists what
it discards, which in a review worktree is only scratch, then removes it.

Review this skill when a blocker it should have caught reaches `main`.
