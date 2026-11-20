import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { prSkeleton } from "../../src/core/conventions.ts";
import { scaffold } from "../../src/core/scaffold.ts";
import {
  behindWarning,
  bodyOnlyProblem,
  changedLines,
  ciLine,
  ciState,
  GATE_TAIL_LINES,
  gateChecks,
  gatedCommit,
  gatePlan,
  gatePlanCommand,
  gateSection,
  listedBeads,
  planPrBody,
  REVIEW_MARKER,
  reviewedHead,
  withCiLine,
  workflowRunsGate,
} from "../../src/core/trackPr.ts";

/** A GitHub Actions expression, written so it isn't read as a JS placeholder. */
const ACTIONS_EXPR = `$${"{{"} matrix.os }}`;

const filled = prSkeleton({
  "What changed and why": "A hand-written narrative.\n\n    indented code stays",
  Evidence: "Ran it on the real handoffs.",
  Gate: "stale output",
  "Not done": "Nothing.",
  Beads: "- `x-abc.1` the first\n- x-abc.2: the second\n\nAnd prose naming x-zzz, not a list item.",
});

describe("track pr's body", () => {
  test("changed lines are insertions plus deletions, from git's shortstat", () => {
    expect(changedLines(" 13 files changed, 675 insertions(+), 143 deletions(-)")).toBe(818);
    expect(changedLines(" 1 file changed, 1 insertion(+)")).toBe(1);
    expect(changedLines(" 2 files changed, 4 deletions(-)")).toBe(4);
    expect(changedLines("")).toBe(0);
  });

  test("the Gate section is the command, the commit and the output's tail, in a fence it can't close", () => {
    const output = [...Array.from({ length: 30 }, (_, i) => `line ${i}`), "```", " 431 pass"].join(
      "\n",
    );
    const section = gateSection("bun run check", "ecdce38aaaaabbbbccc", `${output}\n\n`);
    const lines = section.split("\n");
    expect(lines[0]).toBe("````");
    expect(lines.at(-1)).toBe("````");
    expect(lines[1]).toBe("$ bun run check   # at ecdce38aaaaa, run by mshape track pr");
    expect(lines.slice(2, -1)).toHaveLength(GATE_TAIL_LINES);
    expect(lines.at(-2)).toBe(" 431 pass");
    expect(section).not.toContain("line 0\n");
    // As biome printed it into #35's first Gate section.
    const coloured =
      "\u001b[0m\u001b[34mChecked 101 files in 58\u001b[0m\u001b[0m\u001b[2m\u001b[34mms\u001b[0m";
    expect(gateSection("c", "abc", coloured).split("\n")[2]).toBe("Checked 101 files in 58ms");
  });

  test("beads are the ids that start list items, backticks and trailing punctuation stripped", () => {
    expect(listedBeads(filled)).toEqual(["x-abc.1", "x-abc.2"]);
    expect(listedBeads("## Beads\n\n- not-an-id? no\n* x-def.23 (mail half)\n")).toEqual([
      "x-def.23",
    ]);
    expect(listedBeads("## Other\n\n- x-abc.1\n")).toEqual([]);
    // Decorated as #35's review tried: bold, a link, emphasis; all found.
    expect(
      listedBeads(
        "## Beads\n\n- **x-def.11** x\n- [x-def.12](https://example.test) y\n- _x-abc.3_, z\n",
      ),
    ).toEqual(["x-def.11", "x-def.12", "x-abc.3"]);
  });

  test("the Gate is replaced and every other section kept as written", () => {
    const plan = planPrBody(filled, "fresh output");
    if ("problems" in plan) throw new Error(plan.problems.join("\n"));
    expect(plan.body).toBe(filled.replace("stale output", "fresh output"));
    expect(plan.beads).toEqual(["x-abc.1", "x-abc.2"]);
  });

  test("an unknown section of the agent's survives, and a missing Gate is put in its place", () => {
    const body = filled
      .replace("## Gate\n\nstale output\n\n", "")
      .replace("## Beads", "## Screenshots\n\nnone\n\n## Beads");
    const plan = planPrBody(body, "fresh");
    if ("problems" in plan) throw new Error(plan.problems.join("\n"));
    expect(plan.body).toContain(
      "## Evidence\n\nRan it on the real handoffs.\n\n## Gate\n\nfresh\n\n## Bug class closed",
    );
    expect(plan.body).toContain("## Screenshots\n\nnone\n\n## Beads");
  });

  test("a missing required section, or no bead listed, is refused with what to write", () => {
    const missing = planPrBody(filled.replace("## Not done\n\nNothing.\n\n", ""), "g");
    expect("problems" in missing ? missing.problems : []).toEqual([
      "the PR body lacks `## Not done`: add each heading with its text (a heading with only the template's placeholder counts as missing). The sections and what goes in each are in .github/pull_request_template.md",
    ]);
    // The template's placeholder is not text.
    const unfilled = planPrBody(prSkeleton(), "g");
    expect("problems" in unfilled ? unfilled.problems[0] : "").toContain(
      "lacks `## What changed and why`, `## Evidence`, `## Not done`, `## Beads`",
    );
    const noBeads = planPrBody(filled.replace(/- `x-abc.1`.*\n- x-abc.2: the second\n\n/, ""), "g");
    expect("problems" in noBeads ? noBeads.problems : []).toEqual([
      "the Beads section lists no bead: put each one this PR works on as a list item that starts with its id (`- <bead id> what it is`)",
    ]);
  });
});

describe("reviewedHead", () => {
  const head = "h".repeat(40);
  test("a thread reply (empty body) on the head isn't a review of it", () => {
    expect(reviewedHead([{ commit_id: head, body: "" }], head)).toBe(false);
    expect(reviewedHead([{ commit_id: head, body: "## Fit" }], head)).toBe(true);
  });
  test("once any review is marked, only marked ones count", () => {
    const marked = { commit_id: "o".repeat(40), body: `round 1\n\n${REVIEW_MARKER}` };
    expect(reviewedHead([marked, { commit_id: head, body: "the author's probe" }], head)).toBe(
      false,
    );
    expect(reviewedHead([marked, { commit_id: head, body: REVIEW_MARKER }], head)).toBe(true);
  });
});

describe("--body-only, behind, CI", () => {
  const tip = "a".repeat(40);
  test("gatedCommit reads the commit the Gate section ran on", () => {
    const withGate = prSkeleton({ Gate: gateSection("bun run check", tip, "ok") });
    expect(gatedCommit(withGate)).toBe("aaaaaaaaaaaa");
    expect(gatedCommit(prSkeleton({ Gate: "ran it by hand" }))).toBeUndefined();
  });
  test("bodyOnlyProblem: only when the gate ran on the tip and the tip is the PR's head", () => {
    expect(bodyOnlyProblem({ tip, head: tip, gated: "aaaaaaaaaaaa" })).toBeUndefined();
    expect(bodyOnlyProblem({ tip, head: "b".repeat(40), gated: "aaaaaaaaaaaa" })).toContain(
      "would leave the Gate section false",
    );
    expect(bodyOnlyProblem({ tip, head: tip, gated: "cccccccccccc" })).toContain(
      "would leave the Gate section false",
    );
    expect(bodyOnlyProblem({ tip, head: tip, gated: undefined })).toContain("has none");
  });
  test("behindWarning: nothing when up to date; the count, and conflicts when any", () => {
    expect(behindWarning({ target: "origin/main", behind: 0, conflicts: [] })).toBeUndefined();
    expect(behindWarning({ target: "origin/main", behind: 3, conflicts: undefined })).toContain(
      "3 commits behind `origin/main`.",
    );
    expect(behindWarning({ target: "origin/main", behind: 1, conflicts: ["a.ts"] })).toContain(
      "1 commit behind `origin/main`, and conflicts with it in a.ts.",
    );
  });
  test("ciState: none, running, done with what failed", () => {
    expect(ciState([]).kind).toBe("none");
    expect(ciState([{ id: 1, name: "c", status: "queued", conclusion: null }])).toEqual({
      kind: "running",
      pending: ["c"],
    });
    const done = ciState([
      { id: 1, name: "c", status: "completed", conclusion: "success" },
      { id: 2, name: "d", status: "completed", conclusion: "skipped" },
      { id: 3, name: "e", status: "completed", conclusion: "timed_out" },
    ]);
    expect(done.kind === "done" && done.failed).toEqual(["e (timed_out)"]);
  });
  test("ciState: only runs after the post answer it, judged by each check's latest run", () => {
    const old = { id: 1, name: "body", status: "completed", conclusion: "success" };
    // A body edit: the old run is done, and the rerun hasn't appeared yet.
    expect(ciState([old], new Set([1])).kind).toBe("none");
    const rerun = { id: 5, name: "body", status: "completed", conclusion: "failure" };
    const state = ciState([old, rerun], new Set([1]));
    expect(state.kind === "done" && state.failed).toEqual(["body (failure)"]);
  });
});

describe("gateChecks: the checks CI's gate makes on a PR", () => {
  test("this repo's workflows: ci's check job, and not pr's body or the binary jobs", async () => {
    const dir = join(import.meta.dir, "..", "..", ".github", "workflows");
    const texts = await Promise.all(
      ["ci.yml", "pr.yml"].map((file) => Bun.file(join(dir, file)).text()),
    );
    expect(gateChecks(texts)).toEqual(["check"]);
  });

  test("a job's name wins over its key; a workflow that doesn't run the gate on PRs adds none", () => {
    const named =
      'on: [pull_request]\njobs:\n  gate:\n    name: "The gate"\n    steps:\n      - run: mshape gate\n  other:\n    steps:\n      - run: echo\n';
    expect(gateChecks([named])).toEqual(["The gate"]);
    expect(gateChecks([named.replace("[pull_request]", "[push]")])).toEqual([]);
  });

  test("a job it can't predict is not expected: a name with an expression, or a job-level if (#118's review)", () => {
    const job = (extra: string) =>
      `on: [pull_request]\njobs:\n  gate:\n${extra}    steps:\n      - run: mshape gate\n`;
    expect(gateChecks([job(`    name: gate ${ACTIONS_EXPR}\n`)])).toEqual([]);
    expect(gateChecks([job("    if: github.event_name == 'push'\n")])).toEqual([]);
    // A step-level if is no reason to skip the job.
    expect(
      gateChecks([
        job("").replace(
          "      - run: mshape gate",
          "      - if: always()\n        run: mshape gate",
        ),
      ]),
    ).toEqual(["gate"]);
  });

  test("ciState waits for an expected check with no run yet, matching a matrix job's runs too (#105's real run)", () => {
    const body = { id: 1, name: "body", status: "completed", conclusion: "success" };
    expect(ciState([body], new Set(), ["check"])).toEqual({
      kind: "running",
      pending: ["check (not started)"],
    });
    const check = { id: 2, name: "check", status: "completed", conclusion: "success" };
    expect(ciState([body, check], new Set(), ["check"]).kind).toBe("done");
    const matrix = {
      id: 3,
      name: "e2e (ubuntu-latest)",
      status: "completed",
      conclusion: "success",
    };
    expect(ciState([body, matrix], new Set(), ["e2e"]).kind).toBe("done");
  });
});

const toolchain = {
  bun: "1.4.2",
  monkeyshape: "0.6.0",
  effect: "4.0.0",
  biome: "2.5.15",
  typescript: "7.0.2",
  typesBun: "1.4.2",
};

describe("the template's CI", () => {
  const TEMPLATE = join(import.meta.dir, "..", "..", "template");
  const read = (path: string) => Bun.file(join(TEMPLATE, path)).text();

  test("runs the whole gate, so track pr runs only the fast phase there", async () => {
    for (const path of [".github/workflows/ci.yml", "packs/typescript/.github/workflows/ci.yml"]) {
      const workflow = await read(path);
      expect(workflowRunsGate(workflow)).toBe(true);
      expect(gateChecks([workflow])).toEqual(["check"]);
    }
  });

  test("the common layer installs mshape at the pin and needs no Bun", async () => {
    for (const path of [".github/workflows/ci.yml", ".github/workflows/pr.yml"]) {
      const workflow = await read(path);
      expect(workflow).toContain("install.sh | MSHAPE_VERSION=");
      expect(workflow).toContain("$HOME/.local/bin");
      expect(workflow).not.toMatch(/\bbun\b|setup-bun/);
    }
    expect(await read(".github/workflows/pr.yml")).toContain("| mshape track pr --check-body");
  });

  test("a TypeScript repo reaches mshape through node_modules in both workflows, downloading nothing (#123's review)", async () => {
    // It has Bun and the npm package at its pin anyway; no release need exist for its CI.
    const manifest = JSON.parse(
      scaffold("demo", new Map(), toolchain).get("package.json") ?? "{}",
    ) as { devDependencies?: Record<string, string>; scripts?: Record<string, string> };
    expect(manifest.devDependencies?.["monkeyshape"]).toBeDefined();
    expect(manifest.scripts?.["mshape"]).toBe("mshape");
    for (const path of [
      "packs/typescript/.github/workflows/ci.yml",
      "packs/typescript/.github/workflows/pr.yml",
    ]) {
      const workflow = await read(path);
      expect(workflow).toContain("bun install --frozen-lockfile");
      expect(workflow).toContain("bun run --silent mshape ");
      expect(workflow).not.toContain("install.sh");
    }
  });
});

describe("gatePlan and the CI line", () => {
  const ci =
    "on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  check:\n    steps:\n      - run: bun run --silent mshape gate\n";
  test("a pull_request workflow running the whole gate: its fast phase here", () => {
    expect(gatePlan([ci])).toEqual({ kind: "fast" });
    expect(
      gatePlan(["on: [push, pull_request]\njobs:\n  c:\n    steps:\n      - run: mshape gate\n"])
        .kind,
    ).toBe("fast");
    // A TypeScript repo's alias of it, as repos born before `mshape gate` run it.
    expect(gatePlan([ci.replace("bun run --silent mshape gate", "bun run check")]).kind).toBe(
      "fast",
    );
  });
  test("anything else: the whole gate here", () => {
    expect(gatePlan([])).toEqual({ kind: "full" });
    expect(gatePlan(["on:\n  push:\n      - run: mshape gate\n"])).toEqual({ kind: "full" });
    // Only the fast phase in CI leaves the rest unrun.
    expect(gatePlan([ci.replace("mshape gate", "mshape gate --fast")])).toEqual({ kind: "full" });
  });
  test("a CI that doesn't run the gate on every PR: the whole gate here (#89's review)", () => {
    const pr = (on: string, run: string) =>
      `on:\n${on}jobs:\n  check:\n    steps:\n      - run: ${run}\n`;
    for (const workflow of [
      pr("  push:\n  pull_request:\n", "bun run check:fast"),
      pr("  push:\n  pull_request:\n", "bun run checkout-docs"),
      pr("  push:\n  pull_request:\n", "mshape gateway"),
      pr("  push:\n  pull_request:\n", "mshape gate --fast"),
      pr('  pull_request:\n    paths: ["docs/**"]\n', "mshape gate"),
      pr("  pull_request:\n    branches-ignore: [wip]\n", "mshape gate"),
      pr("  push: # not on pull_request: too slow\n", "mshape gate"),
      pr("  pull_request:\n    types: [opened, reopened]\n", "mshape gate"),
      pr("  pull_request:\n    types:\n      - opened\n", "mshape gate"),
      pr('  pull_request: { paths: ["docs/**"] }\n', "mshape gate"),
      pr("  pull_request: { types: [opened] }\n", "mshape gate"),
      pr("  pull_request:\n    branches: [release]\n", "mshape gate"),
    ])
      expect(workflowRunsGate(workflow)).toBe(false);
    // The usual base filter, and types that include synchronize: every PR into main.
    for (const workflow of [
      pr("  pull_request:\n    branches: [main]\n", "mshape gate"),
      pr("  pull_request:\n    branches:\n      - main\n", "bun run --silent mshape gate"),
      pr("  pull_request:\n    types: [opened, synchronize, reopened]\n", "mshape gate"),
      pr("  pull_request: { branches: [main] }\n", "bun run check"),
      pr("  pull_request:\n", '"mshape gate"'),
      pr("  pull_request:\n", "|\n          bun install\n          mshape gate"),
      pr("  pull_request:\n", "mshape gate --config ci.toml"),
    ])
      expect(workflowRunsGate(workflow)).toBe(true);
  });
  test("gatePlanCommand and the CI line", () => {
    expect(gatePlanCommand({ kind: "fast" })).toBe("mshape gate --fast");
    expect(gatePlanCommand({ kind: "full" })).toBe("mshape gate");
    const pending = gateSection("bun run a", "c".repeat(40), "ok", ciLine("c".repeat(40)));
    expect(pending).toContain("CI: runs the whole gate on cccccccccccc, not track pr");
    const done = withCiLine(
      pending,
      ciLine("c".repeat(40), [
        { id: 1, name: "check", status: "completed", conclusion: "success", html_url: "u" },
      ]),
    );
    expect(done).toContain("CI on cccccccccccc: check: success ([run](u)).");
    expect(done).not.toContain("runs the tests");
    expect(withCiLine(gateSection("bun run check", "c".repeat(40), "ok"), "x")).toBeUndefined();
  });

  test("CI's test counts ride on the CI line, and recording CI again replaces them (rdw)", () => {
    const pending = gateSection("bun run a", "c".repeat(40), "ok", ciLine("c".repeat(40)));
    const runs = [
      { id: 1, name: "check", status: "completed", conclusion: "success", html_url: "u" },
      { id: 2, name: "body", status: "completed", conclusion: "success" },
    ];
    const tests = (counts: string) =>
      new Map([["check", [`bun-test passed: ${counts}`]]]) as ReadonlyMap<
        string,
        ReadonlyArray<string>
      >;
    const first = withCiLine(
      pending,
      ciLine("c".repeat(40), runs, tests("1489 passed, 1 skipped")),
    );
    expect(first).toContain(
      "CI on cccccccccccc: check: success ([run](u)), body: success. Tests: bun-test passed: 1489 passed, 1 skipped (check).",
    );
    const again = withCiLine(first ?? "", ciLine("c".repeat(40), runs, tests("1490 passed")));
    expect(again).toContain("Tests: bun-test passed: 1490 passed (check).");
    expect(again).not.toContain("1489");
    // A check whose log had no counts adds nothing.
    expect(ciLine("c".repeat(40), runs)).toBe(
      "CI on cccccccccccc: check: success ([run](u)), body: success.",
    );
  });
});
