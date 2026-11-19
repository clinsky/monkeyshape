/**
 * The rules check's two kinds for the repo's own rules, raised as a repo now raises them:
 * through shape-rules/, as ast-grep ran it. Spread into test/core/ruleCases.test.ts.
 */
import type { ShapeRuleRun } from "../../src/core/model.ts";
import type { Cases } from "./ruleCase.ts";

/** A rule in shape-rules/ as ast-grep ran it: matching nothing, its cases behaving as labelled. */
const LOCAL: ShapeRuleRun = {
  file: "shape-rules/no-save.yml",
  id: "no-save",
  language: "typescript",
  message: "calls save directly; write through saveMerged.",
  bugClass: "Writes that skip the merge function.",
  matches: [],
  cases: {
    state: "ran",
    file: "shape-rules/no-save.test.yml",
    runs: [
      { kind: "invalid", index: 1, matches: 1 },
      { kind: "valid", index: 1, matches: 0 },
    ],
  },
};

export const localRuleCases: Record<string, Cases> = {
  "rules/local-rule": {
    fail: { shapeRules: [{ ...LOCAL, bugClass: "" }] },
    pass: { shapeRules: [LOCAL], files: { "src/a.ts": "saveMerged(x);\n" } },
  },
  "rules/local-cases": {
    fail: {
      shapeRules: [
        {
          ...LOCAL,
          cases: {
            state: "ran",
            file: "shape-rules/no-save.test.yml",
            runs: [{ kind: "valid", index: 1, matches: 0 }],
          },
        },
      ],
    },
    pass: { shapeRules: [LOCAL] },
  },
};
