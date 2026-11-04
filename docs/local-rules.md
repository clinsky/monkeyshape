# Local rules

A bug class that belongs to your domain, one monkeyshape can't know about, gets a rule in your
own repo. It runs in the same engine as monkeyshape's rules, over the same `sources`, with the
same allowances, `shape-ignore` comments and report format. It is reported as `local/<id>`.

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

The rule. `check` gets each file in `sources`, parsed, and returns the offset of each
violation. `cases` are run at every `mshape check`, and every case must parse. A rule with no
must-fail case, or no must-pass case, fails the gate, and so does one that misses a must-fail
case or fires on a must-pass or allowed case. That way the rule can't quietly stop working.

```ts
// rules/indexWrites.ts
import { defineRule, walk } from "monkeyshape";

/** The enforcement point: the one file that may write an index directly. */
const ENFORCEMENT_POINT = "src/store/index.ts";

export default defineRule({
  id: "index-writes-merge",
  bugClass: "An index written with only this run's records, dropping what earlier runs recorded.",
  message:
    "writes an index directly, which replaces what earlier runs recorded. Call saveIndex from src/store/index.ts, which merges them first.",
  cases: {
    fail: [
      'writeDataset({ kind: "index", name: "modules", records });',
      // A kind the rule can't read might be "index": it is reported too.
      "writeDataset({ kind, name, records });",
    ],
    pass: ['saveIndex("modules", records);', 'writeDataset({ kind: "run", name: "log", records });'],
    allowed: [
      {
        path: ENFORCEMENT_POINT,
        source: 'writeDataset({ kind: "index", name, records: mergeIndex(prior, records) });',
      },
    ],
  },
  check: (file) => {
    if (file.path === ENFORCEMENT_POINT) return [];
    const found: Array<number> = [];
    walk(file.program, {
      CallExpression: (node) => {
        if (node.callee.type !== "Identifier" || node.callee.name !== "writeDataset") return;
        const options = node.arguments[0];
        const kind =
          options?.type === "ObjectExpression"
            ? options.properties.find(
                (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "kind",
              )
            : undefined;
        // Only a kind written out as another literal is safe to pass.
        const literal =
          kind?.type === "Property" && kind.value.type === "Literal" ? kind.value.value : undefined;
        if (typeof literal !== "string" || literal === "index") found.push(node.start);
      },
    });
    return found;
  },
});
```

`shape.config.ts` imports the module and lists it. It also adds `rules/` to `sources`, so the
rule modules are checked like the rest of the code; without that, `sources` fails on them as
TypeScript that no rule analyzes:

```ts
// shape.config.ts
import { defineConfig } from "monkeyshape";
import indexWrites from "./rules/indexWrites.ts";

export default defineConfig({
  sources: { include: ["src/**/*.{ts,tsx}", "rules/**/*.ts"] },
  localRules: [indexWrites],
});
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

## The interface

Everything comes from `monkeyshape`:

- `defineRule({ id, bugClass, message, check, cases })`. `id` is lowercase words joined by
  hyphens. `check(file)` must be synchronous: it gets `{ path, text, program }` and returns
  offsets, either as numbers or as `{ offset, message }`. Cases are source text, or
  `{ path, source }` when the rule looks at the path; the default path is src/case.ts.
- `walk(program, { NodeType: (node) => ... })` calls each handler on every node of that type,
  parents before children, with the node typed.
- The types `LocalRule`, `SourceFile`, `Finding`, `Visitors`, `Node`, `Program` and
  `Expression`. The tree is ESTree, with TypeScript nodes, as oxc produces it. Offsets are
  UTF-16 code units, the same as string indices. Read the tree, never change it: every rule
  gets the same one.

The example makes its exception in `check`. It could instead leave `check` to report
everything and exempt the enforcement point in the config, with
`rules["local/index-writes-merge"].allow`. An `allowed` case at an allowed path then reports
nothing, as in a real run. In the code, the exception sits beside the rule and its cases;
in the config, garden counts it as an escape hatch.

In `shape.config.ts`, `rules["local/<id>"]` takes `off` and `allow` like any rule, and
`// shape-ignore local/<id>: <reason>` covers its own line and the next. `mshape rules` lists
local rules under the layer `local`.

The gate fails, as `rules/local-rule`, when a module's export isn't a rule, two entries share
an id, or `check` throws or returns something other than offsets in the file. A module that
doesn't load fails the config load. A problem with a rule's cases fails as `rules/local-cases`.
