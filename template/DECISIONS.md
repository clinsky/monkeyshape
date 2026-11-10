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

Each entry is a heading `## D-<slug>: <the decision, as a sentence>` followed by five lines:
`Decision:` what we do; `Tempting wrong fix:` what looks right and isn't, and why;
`Evidence:` how it was verified, or `policy`; `Enforced by:` the check or test that keeps it
true; `Revisit when:` the condition that would change it.
