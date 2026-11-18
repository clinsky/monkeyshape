# Local rules

A bug class that belongs to your domain, one monkeyshape can't know about, gets a rule in your
own repo, in any language your packs read. It is an [ast-grep](https://ast-grep.github.io)
rule in `shape-rules/`, run over the same `sources` as monkeyshape's rules, with the same
allowances, `shape-ignore` comments and report format. It is reported as `local/<id>`.
`mshape` brings its own ast-grep: it is fetched and verified on the first check of a repo
that has rules, and cached for the next.

## The pattern: one enforcement point, and a rule that bans going around it

A rule that recognises the bug as it was last written catches that version only; the next one
will be written differently. So don't describe the bug. Give the invariant **one function that
enforces it**, then write a rule that bans the operation it guards anywhere else. The rule then
catches every way of going around the function, including ones nobody has written yet.

The example below is an index of records that many runs write to. The bug: a run writes the
index with only its own records, which drops everything earlier runs recorded. The enforcement
point is `saveIndex`, which merges the prior records first. The rule bans writing an index
any other way.

```ts
// src/store/index.ts
import { mergeIndex, readIndex, writeDataset } from "./datasets.ts";

/** The only way to write an index: earlier runs' records are kept, this run's win. */
export const saveIndex = (name: string, records: ReadonlyArray<IndexRecord>) =>
  writeDataset({ kind: "index", name, records: mergeIndex(readIndex(name), records) });
```

The rule is `shape-rules/<id>.yml`, named after its id: an ast-grep rule (`id`, `language`,
`rule`, `message`) with the class of bug it removes as `metadata.bugClass`. This one reports
every `writeDataset` call except one whose `kind` is written out as a string other than
`"index"`, so a kind it can't read is reported too.

```yaml
# shape-rules/index-writes-merge.yml
id: index-writes-merge
language: typescript
message: writes an index directly, which replaces what earlier runs recorded. Call saveIndex from src/store/index.ts, which merges them first.
metadata:
  bugClass: An index written with only this run's records, dropping what earlier runs recorded.
rule:
  pattern: writeDataset($$$ARGS)
  not:
    has:
      field: arguments
      has:
        kind: object
        has:
          kind: pair
          all:
            - has: { field: key, regex: "^kind$" }
            - has: { field: value, kind: string, not: { regex: "^.index.$" } }
```

Its cases sit beside it in `<id>.test.yml`, as ast-grep writes them: `invalid` snippets have
the bug and must be reported, `valid` ones are code close to it on which nothing may be. They
run at every `mshape check`. A rule with no cases file, no `invalid` case or no `valid` case
fails the gate, and so does one that misses an `invalid` case or fires on a `valid` one. That
way the rule can't quietly stop working.

```yaml
# shape-rules/index-writes-merge.test.yml
invalid:
  - 'writeDataset({ kind: "index", name: "modules", records });'
  # A kind the rule can't read might be "index": it is reported too.
  - "writeDataset({ kind, name, records });"
valid:
  - 'saveIndex("modules", records);'
  - 'writeDataset({ kind: "run", name: "log", records });'
```

The enforcement point itself writes the index, so shape.toml allows the rule there, with the
reason; garden counts the allowance as an escape hatch.

```toml
# shape.toml
packs = ["typescript"]

[rules."local/index-writes-merge"]
allow = [
  { path = "src/store/index.ts", reason = "the enforcement point: it merges earlier runs' records before it writes" },
]
```

A job that writes the index itself fails the gate:

```ts
// src/jobs/collect.ts
import { writeDataset } from "../store/datasets.ts";

export const collect = (records: ReadonlyArray<IndexRecord>) =>
  writeDataset({ kind: "index", name: "modules", records });
```

```
src/jobs/collect.ts:5  rules/local/index-writes-merge
  writes an index directly, which replaces what earlier runs recorded. Call saveIndex from src/store/index.ts, which merges them first.
```

The fix goes through the enforcement point:

```ts
// src/jobs/collect.ts, fixed
import { saveIndex } from "../store/index.ts";

export const collect = (records: ReadonlyArray<IndexRecord>) => saveIndex("modules", records);
```

## The rest

- A rule's `language` is any ast-grep reads: `typescript`, `tsx`, `rust`, `python` and more.
  A match counts in a file a listed pack claims and `sources` includes; elsewhere it doesn't.
- In shape.toml, `[rules."local/<id>"]` takes `off` and `allow` like any rule, and a
  `shape-ignore local/<id>: <reason>` line comment, in the file's own comment syntax, covers
  its own line and the next. ast-grep's own `severity` is ignored: a match fails the gate.
- `mshape rules` lists local rules under the layer `local`, with their `bugClass`.
- The gate fails as `rules/local-rule` when a rule file isn't YAML, ast-grep rejects it (its
  reason is quoted), its id doesn't match its file name or is already a rule's, or it lacks a
  `message` or `metadata.bugClass`. A problem with its cases fails as `rules/local-cases`.
- Without ast-grep (offline, nothing cached), the rules check is unavailable, and the gate
  fails until it can be fetched.
- A repo whose shape.config.ts still lists TypeScript rule modules in `localRules` keeps
  running them, as `local/<id>` too, until they are ported to `shape-rules/`.
