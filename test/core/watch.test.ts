/**
 * The decisions of `mshape msg watch`, row by row of the plan's Watches table where a row is a
 * decision; the rows about storage, sessions and gh are in `test/adapters/watch.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { subjectProblem } from "../../src/core/mail.ts";
import {
  decideBead,
  decideCi,
  decideMain,
  decidePr,
  decodeBead,
  decodePr,
  decodeRuns,
  decodeWatch,
  encodeWatch,
  parseTarget,
  type Run,
} from "../../src/core/watch.ts";

const SHA = "1a45d74188efdd0e72913e84a34ffa7a18a4ee58";
const OTHER = "f53186d6ae540e664f79d2ed8297717bf392df2d";
const THIRD = "0d68ba25e25141eee54726add2e04eb89cb3e832";

const run = (over: Partial<Run>): Run => ({
  sha: SHA,
  workflow: "ci",
  status: "completed",
  conclusion: "success",
  url: "https://example.com/runs/1",
  title: "Merge pull request #144 from someone/branch",
  created: "2026-11-19T18:50:50Z",
  ...over,
});

describe("a watched PR", () => {
  const watch = { kind: "pr", pr: "12" } as const;
  const pr = { title: "Add a thing", url: "https://example.com/pull/12" };

  test("open: nothing, and the watch stays", () => {
    expect(decidePr(watch, { ...pr, state: "OPEN" })).toEqual({ events: [], next: watch });
  });

  test("merges: one message, '#N merged' with its merge commit; the watch is removed", () => {
    const decided = decidePr(watch, { ...pr, state: "MERGED", mergeCommit: SHA });
    expect(decided.next).toBeUndefined();
    expect(decided.events).toHaveLength(1);
    expect(decided.events[0]?.subject).toBe("#12 merged: Add a thing");
    expect(decided.events[0]?.body).toContain(`merged as ${SHA}`);
    expect(decided.events[0]?.key).toBe("pr-12-merged");
  });

  test("closes unmerged: one message saying so; removed", () => {
    const decided = decidePr(watch, { ...pr, state: "CLOSED" });
    expect(decided.next).toBeUndefined();
    expect(decided.events.map((event) => event.subject)).toEqual([
      "#12 closed without merging: Add a thing",
    ]);
  });

  test("a title too long or on two lines still makes a subject every notice can show", () => {
    const decided = decidePr(watch, {
      ...pr,
      title: `line one\nline two ${"x".repeat(300)}`,
      state: "MERGED",
    });
    expect(subjectProblem(decided.events[0]?.subject ?? "")).toBeUndefined();
  });
});

describe("a watched bead", () => {
  const watch = { kind: "bead", id: "repo-1a.2" } as const;

  test("closes: one message with its close reason; removed", () => {
    const decided = decideBead(watch, {
      status: "closed",
      title: "Do it",
      closeReason: "Merged in #12",
    });
    expect(decided.next).toBeUndefined();
    expect(decided.events[0]?.subject).toBe("repo-1a.2 closed: Do it");
    expect(decided.events[0]?.body).toContain("Reason: Merged in #12");
  });

  test("open or in progress: nothing", () => {
    for (const status of ["open", "in_progress", "blocked"])
      expect(decideBead(watch, { status, title: "Do it" })).toEqual({ events: [], next: watch });
  });
});

describe("CI on a watched head", () => {
  const watch = { kind: "ci", sha: SHA } as const;

  test("still running, or no run yet: nothing", () => {
    expect(decideCi(watch, []).events).toEqual([]);
    expect(decideCi(watch, [run({}), run({ status: "in_progress", conclusion: "" })]).next).toBe(
      watch,
    );
  });

  test("ends green: one message, pass, with the run's URL; removed", () => {
    const decided = decideCi(watch, [run({}), run({ sha: OTHER, conclusion: "failure" })]);
    expect(decided.next).toBeUndefined();
    expect(decided.events[0]?.subject).toBe("CI passed on 1a45d74");
    expect(decided.events[0]?.body).toContain("https://example.com/runs/1");
  });

  test("ends red: one message, fail, naming the failed run and its URL; removed", () => {
    const decided = decideCi(watch, [
      run({}),
      run({ workflow: "lint", conclusion: "failure", url: "https://example.com/runs/2" }),
    ]);
    expect(decided.next).toBeUndefined();
    expect(decided.events[0]?.subject).toBe("CI failed on 1a45d74: lint");
    expect(decided.events[0]?.body).toContain("failed: https://example.com/runs/2");
  });

  test("a skipped or neutral run is no failure", () => {
    const decided = decideCi(watch, [
      run({ conclusion: "skipped" }),
      run({ conclusion: "neutral" }),
    ]);
    expect(decided.events[0]?.subject).toBe("CI passed on 1a45d74");
  });
});

describe("a watch on main", () => {
  const watch = { kind: "main", since: "2026-11-19T00:00:00Z", red: false } as const;
  const red = run({ sha: OTHER, conclusion: "failure", created: "2026-11-19T10:00:00Z" });

  test("CI fails on a new head: one message per failing head, naming the merged PR; the watch stays", () => {
    const decided = decideMain(watch, [
      run({
        sha: THIRD,
        conclusion: "failure",
        created: "2026-11-19T11:00:00Z",
        title: "Fix it (#145)",
      }),
      red,
    ]);
    expect(decided.events.map((event) => event.subject)).toEqual([
      "main is red at f53186d (#144)",
      "main is red at 0d68ba2 (#145)",
    ]);
    expect(decided.next).toEqual({ kind: "main", since: "2026-11-19T11:00:00Z", red: true });
  });

  test("green again after red: one message; the watch stays", () => {
    const decided = decideMain({ ...watch, since: red.created, red: true }, [
      run({ created: "2026-11-19T12:00:00Z" }),
      red,
    ]);
    expect(decided.events.map((event) => event.subject)).toEqual([
      "main is green again at 1a45d74 (#144)",
    ]);
    expect(decided.next).toEqual({ kind: "main", since: "2026-11-19T12:00:00Z", red: false });
  });

  test("green after green, or a head older than the watch: nothing", () => {
    expect(decideMain(watch, [run({ created: "2026-11-19T12:00:00Z" })]).events).toEqual([]);
    expect(
      decideMain(
        watch,
        [red].map((r) => ({ ...r, created: "2026-11-18T00:00:00Z" })),
      ).events,
    ).toEqual([]);
  });

  test("a head still running holds back the heads after it, so none is decided twice or skipped", () => {
    const running = run({
      sha: OTHER,
      status: "in_progress",
      conclusion: "",
      created: "2026-11-19T10:00:00Z",
    });
    const later = run({ sha: THIRD, conclusion: "failure", created: "2026-11-19T11:00:00Z" });
    const first = decideMain(watch, [later, running]);
    expect(first).toEqual({ events: [], next: watch });
    const second = decideMain(watch, [
      later,
      { ...running, status: "completed", conclusion: "success" },
    ]);
    expect(second.events.map((event) => event.key)).toEqual([`main-red-${THIRD}`]);
    // Decided again from where it stopped: nothing new.
    expect(decideMain(second.next as typeof watch, [later, running]).events).toEqual([]);
  });

  test("a head with a failing and a passing workflow is red", () => {
    const decided = decideMain(watch, [red, { ...red, workflow: "other", conclusion: "success" }]);
    expect(decided.events).toHaveLength(1);
  });
});

describe("what a watch command names", () => {
  test("each kind, and why a wrong one isn't", () => {
    expect(parseTarget(["pr", "#12"])).toEqual({ kind: "pr", pr: "12" });
    expect(parseTarget(["bead", "repo-1a.2"])).toEqual({ kind: "bead", id: "repo-1a.2" });
    expect(parseTarget(["ci", "1a45d74"])).toEqual({ kind: "ci", sha: "1a45d74" });
    expect(parseTarget(["main"])).toEqual({ kind: "main" });
    expect(parseTarget(["pr", "twelve"])).toBe("`twelve` is not a pull request number");
    expect(parseTarget(["ci", "HEAD"])).toContain("is not a commit id");
    expect(parseTarget(["main", "now"])).toContain("is not something to watch");
    expect(parseTarget(["issue", "3"])).toContain("is not something to watch");
    expect(parseTarget(["pr"])).toContain("name one thing to watch");
  });

  test("a stored watch decodes strictly", () => {
    const main = { kind: "main", since: "2026-11-19T00:00:00Z", red: true } as const;
    expect(decodeWatch(encodeWatch(main))).toEqual(main);
    expect(decodeWatch('{"kind":"pr","pr":"1","extra":1}')).toBe("unknown keys: extra");
    expect(decodeWatch('{"kind":"main","since":"x","red":"no"}')).toContain("red");
    expect(decodeWatch('{"kind":"issue"}')).toContain("unknown kind");
  });
});

describe("what gh and bd print", () => {
  test("a PR, a bead and runs, as this machine's gh 2.4 and bd print them", () => {
    expect(
      decodePr(
        `{"mergeCommit":{"oid":"${SHA}"},"state":"MERGED","title":"T","url":"https://example.com/pull/1"}`,
      ),
    ).toEqual({ state: "MERGED", title: "T", url: "https://example.com/pull/1", mergeCommit: SHA });
    expect(decodePr('{"mergeCommit":null,"state":"OPEN","title":"T","url":"u"}')).toEqual({
      state: "OPEN",
      title: "T",
      url: "u",
    });
    expect(
      decodeBead('[{"id":"x-1","title":"T","status":"closed","close_reason":"Merged in #1"}]'),
    ).toEqual({ status: "closed", title: "T", closeReason: "Merged in #1" });
    const runs = decodeRuns(
      JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            head_sha: SHA,
            name: "ci",
            status: "completed",
            conclusion: "success",
            html_url: "https://example.com/runs/1",
            display_title: "Merge pull request #144 from someone/branch",
            created_at: "2026-11-19T18:50:50Z",
          },
        ],
      }),
    );
    expect(runs).toEqual([run({})]);
    expect(decodeRuns('{"workflow_runs":[{"conclusion":null}]}')).toBe(
      "a run with no head or time",
    );
  });
});
