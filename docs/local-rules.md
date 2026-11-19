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

## Three kinds of rule

Most domain rules are one of three kinds. Each is written below for a generic domain; the
cases are run by this doc's test like the rest.

**Tokens banned in comments.** A comment that cites a closed ticket as its reason keeps
pointing at it after nobody reads it. Matching only `comment` nodes leaves strings alone, so
a prompt that quotes the id is fine.

```yaml
# shape-rules/no-closed-ticket.yml
id: no-closed-ticket
language: typescript
message: cites a closed ticket as its reason. Say the reason itself; the ticket and the commit keep the history.
metadata:
  bugClass: A comment whose reason is a closed ticket, which nobody re-reads once it closes.
rule:
  kind: comment
  regex: "`(OPS-112|OPS-140)`"
```

```yaml
# shape-rules/no-closed-ticket.test.yml
invalid:
  - "/** Re-walks the frontier (`OPS-112`). */\nexport const a = 1;"
  - "export const b = 2; // keeps the nearest one (`OPS-140`)"
valid:
  - 'export const prompt = "cite `OPS-112` here";'
  - "// Calls `readFile`, which `id` names.\nexport const c = 3;"
```

**Going around an enforcement point.** A service hands out a guarded operation and also
holds the raw thing it guards: here `Storage.root`, beside `storage.lend(dir)`, which records
what is written. The rule bans the field wherever the service is bound in the same function,
by `yield*` or by a parameter's type, and names the binding in its message (`$W`).

```yaml
# shape-rules/storage-root.yml
id: storage-root
language: typescript
message: reads $W.root, which skips what lend records. Lend a directory with $W.lend(dir) instead.
metadata:
  bugClass: A path joined onto the storage root, whose writes nothing records or reverts.
utils:
  bound:
    any:
      - pattern: const $W = yield* Storage
      - kind: required_parameter
        all:
          - has: { field: pattern, pattern: $W }
          - has: { field: type, regex: 'Storage\["Service"\]' }
rule:
  any:
    - pattern: $W.root
      inside:
        stopBy: end
        any:
          - kind: arrow_function
          - kind: function_expression
          - kind: generator_function
          - kind: function_declaration
          - kind: generator_function_declaration
          - kind: method_definition
        has: { stopBy: end, matches: bound }
    - pattern: (yield* Storage).root
    - pattern: const { root } = yield* Storage
```

```yaml
# shape-rules/storage-root.test.yml
invalid:
  - 'const f = function* () { const st = yield* Storage; return join(st.root, "state"); };'
  - 'const f = (s: Storage["Service"]) => s.root;'
  - "const f = function* () { const { root } = yield* Storage; return root; };"
  - "const f = function* () { return (yield* Storage).root; };"
valid:
  - 'const f = function* () { const st = yield* Storage; return yield* st.lend("state/db"); };'
  - "const g = (tree: Tree) => tree.root.left;"
  - "const h = (st: Other) => st.root;"
```

**A vocabulary a layer doesn't speak.** The engine names no vendor: vendors are data. `files`
scopes the rule to the engine's directories, and a case with a `path` runs as a file there,
so the scope is tested too. The regex matches a name as a word in camelCase, `acmeRoot` but
not `macmeal`: no lowercase letter may touch it on either side.

```yaml
# shape-rules/no-vendor.yml
id: no-vendor
language: typescript
message: '"$N" names a vendor. Keep vendors in data and tests; the engine (src/core) names none.'
metadata:
  bugClass: A vendor's name in the engine, which binds it to one product.
files: ["src/core/**"]
rule:
  pattern: $N
  any: [{ kind: identifier }, { kind: property_identifier }, { kind: comment }, { kind: string_fragment }]
  regex: "(^|[^a-z])(?i:acme|globex)([^a-z]|$)"
```

```yaml
# shape-rules/no-vendor.test.yml
invalid:
  - path: src/core/layout.ts
    code: "export const acmeRoot = 1;"
  - path: src/core/layout.ts
    code: "// The Globex layout.\nexport const x = 1;"
valid:
  - path: src/core/layout.ts
    code: "export const macmeal = (taxis: number) => taxis;"
  - path: src/cli/targets.ts
    code: 'export const vendor = "acme";'
```

What these can't do, and why it is left so:

- **One finding per node.** A rule reports the node it matched, once, at the node's first line:
  a `/** ... */` comment over several lines is reported at its first, and its `shape-ignore`
  goes on the line above it. A message names what matched through a metavariable (`$N`), the
  whole node.
- **No dataflow.** A pattern sees the code as written, so `const s = st; s.root` is not
  `st.root`. Follow a binding through `inside`/`has` in the same function, as `storage-root`
  does; past that, make the enforcement point the only way to get the thing at all.

## The rest

- A case is a snippet, run with no path, or `{ path, code }`, run as a file at that path so
  the rule's `files` and `ignores` apply as in a real run.
- A rule's `language` is a listed pack's, as ast-grep names it: `typescript`, `ts` or `tsx`;
  `rust`; `python`. Rules run over the files a listed pack claims and `sources` includes, so a
  rule in another language (`yaml`, `javascript`) could never report: it fails as
  `rules/local-rule`. Check such files with a command in `coverage.commands` instead.
- One rule per file: ast-grep's `---`-separated rules in one file fail as `rules/local-rule`.
- In shape.toml, `[rules."local/<id>"]` takes `off` and `allow` like any rule, and a
  `shape-ignore local/<id>: <reason>` line comment, in the file's own comment syntax, covers
  its own line and the next. ast-grep's own `severity` is ignored: a match fails the gate.
- `mshape rules` lists local rules under the layer `local`, with their `bugClass`.
- The gate fails as `rules/local-rule` when a rule file isn't YAML, ast-grep rejects it (its
  reason is quoted), its id doesn't match its file name or is already a rule's, or it lacks a
  `message` or `metadata.bugClass`. A problem with its cases fails as `rules/local-cases`.
- Without ast-grep (offline, nothing cached), the rules check is unavailable, and the gate
  fails until it can be fetched.
- A repo from before 0.6.0 whose shape.config.ts lists TypeScript rule modules in
  `localRules` ports each to `shape-rules/<id>.yml`, keeping its id, then runs
  `mshape config migrate`, which refuses until every one is ported. mshape runs no `localRules`.
