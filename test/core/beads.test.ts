import { describe, expect, test } from "bun:test";
import { BEADS_EXPORT, checkBeads, parseBeadsExport } from "../../src/core/beads.ts";
import { assess } from "../../src/core/check.ts";
import type { BeadSummary, Integration, Snapshot } from "../../src/core/model.ts";
import { formatCheck } from "../../src/core/report.ts";
import { config, repo } from "../support.ts";

const bead = (
  id: string,
  status: string,
  labels: ReadonlyArray<string> = [],
  type = "task",
): BeadSummary => ({ id, title: `the ${id} work`, status, type, labels });

describe("the beads check", () => {
  test("each message names the bead by id and title and gives the command that fixes it", () => {
    const found = checkBeads(
      {},
      repo(
        {},
        { beadRows: [bead("x-1", "blocked"), bead("x-2", "deferred", ["track:a", "track:b"])] },
      ),
    );
    expect(found.map((v) => [v.rule, v.file, v.message])).toEqual([
      [
        "beads/unowned",
        ".beads",
        'bead x-1 ("the x-1 work") is blocked, but no track owns it, so no `track list` counts it. Give it to the track doing it (`bd update x-1 --add-label track:<name>`), label work no track does `milestone` or `process`, or defer it (`bd defer x-1`)',
      ],
      [
        "beads/deferred-in-track",
        ".beads",
        'bead x-2 ("the x-2 work") is deferred but still labelled `track:a`, `track:b`, so it counts as that track\'s open work: the track is never done and `track rm` refuses. Remove the label (`bd update x-2 --remove-label track:a`, `bd update x-2 --remove-label track:b`), or undefer it if the track will do it now',
      ],
    ]);
  });

  test("a repo that doesn't work in tracks yet, as a born repo, has no owner to give: none unowned", () => {
    // As CI found on #39: mshape init's repo, its first bead, no tracks yet.
    const born = repo({}, { beadRows: [bead("demo-1", "open"), bead("demo-2", "closed")] });
    expect(checkBeads({}, born)).toEqual([]);
    // Its first track label, even on a closed bead, and the rule applies from then on.
    const tracked = repo(
      {},
      { beadRows: [bead("demo-1", "open"), bead("demo-2", "closed", ["track:a"])] },
    );
    expect(checkBeads({}, tracked).map((v) => v.rule)).toEqual(["beads/unowned"]);
  });

  test("pinned is frozen like deferred; a bd milestone, like an epic, needs no owner", () => {
    const tracked = bead("x-0", "closed", ["track:a"]);
    const found = checkBeads(
      {},
      repo(
        {},
        {
          beadRows: [
            tracked,
            bead("x-1", "pinned", ["track:other"]),
            bead("x-2", "pinned"),
            bead("x-3", "open", [], "milestone"),
          ],
        },
      ),
    );
    expect(found.map((v) => [v.rule, v.message.slice(0, 40)])).toEqual([
      ["beads/deferred-in-track", 'bead x-1 ("the x-1 work") is pinned but '],
    ]);
  });

  test("a TODO naming a closed bead is reported on its own line, in a block comment too", () => {
    const text = "const a = 1;\n/**\n * Explains a.\n * TODO(x-1): drop this once bd can.\n */\n";
    const [found] = checkBeads(
      {},
      repo({ "src/a.ts": text }, { beadRows: [bead("x-1", "closed")] }),
    );
    expect(found?.line).toBe(4);
    expect(found?.message).toStartWith('`TODO(x-1)` names a closed bead ("the x-1 work")');
  });

  test("without bd's beads, nothing is reported: the check is skipped, and says so elsewhere", () => {
    expect(checkBeads({}, repo({ "src/a.ts": "// TODO(x-1)\n" }))).toEqual([]);
  });
});

describe("beads from the export, where bd can't run", () => {
  const NO_BD = { state: "unavailable", reason: "bd is not on PATH" } as const;
  const NO_DB = {
    state: "unavailable",
    reason: "this clone has no beads database yet; run `bd bootstrap`",
  } as const;
  /** A repo whose loader found bd as `beads` and, if given, read the export's `rows`. */
  const loaded = (
    beads: Integration,
    rows?: ReadonlyArray<BeadSummary> | { invalid: string },
  ): Snapshot => {
    const base = repo({ "src/a.ts": "// TODO(x-1): undo\n" }, { beads });
    if (rows === undefined) return base;
    if ("invalid" in rows)
      return {
        ...base,
        beadsExport: { path: BEADS_EXPORT, state: "invalid", reason: rows.invalid },
      };
    return {
      ...base,
      beadIds: new Set(rows.map((b) => b.id)),
      beadRows: rows,
      beadsExport: { path: BEADS_EXPORT, state: "read" },
    };
  };
  const line = (snapshot: Snapshot) =>
    formatCheck(assess(config(), snapshot, {}, ["beads"]))
      .split("\n")
      .filter((l) => l.startsWith("  beads") || l.startsWith("note:"));

  test("bd and a database: the database, as today", () => {
    const run = assess(config(), repo({}, { beadRows: [bead("x-1", "open", ["track:a"])] }), {}, [
      "beads",
    ]);
    expect(run.reports[0]?.outcome).toEqual({ state: "passed", examined: "1 bead" });
    expect(run.notes).toEqual([]);
  });

  test("no bd, the export committed: the check finds from it, and its line says so", () => {
    const snapshot = loaded(NO_BD, [bead("x-1", "closed"), bead("x-0", "open", ["track:a"])]);
    const run = assess(config(), snapshot, {}, ["beads"]);
    expect(run.result.failing.map((v) => v.rule)).toEqual(["beads/todo-closed"]);
    expect(line(snapshot)).toEqual([
      "note: read beads from the export, .beads/issues.jsonl, and skipped budgets/memories-count, budgets/memories-bytes, which it doesn't hold: bd is not on PATH",
      "  beads  failed          2 beads, from the export (.beads/issues.jsonl)",
    ]);
  });

  test("no bd, no export: unavailable, as today", () => {
    expect(assess(config(), loaded(NO_BD), {}, ["beads"]).reports[0]?.outcome).toEqual({
      state: "unavailable",
      prerequisite: "bd",
      reason: "bd is not on PATH",
      required: false,
    });
  });

  test("bd present but no database, an export: the export, with bootstrap's note", () => {
    const snapshot = loaded(NO_DB, [bead("x-1", "open", ["track:a"])]);
    expect(line(snapshot)).toEqual([
      "note: read beads from the export, .beads/issues.jsonl, and skipped budgets/memories-count, budgets/memories-bytes, which it doesn't hold: this clone has no beads database yet; run `bd bootstrap`",
      "  beads  passed          1 bead, from the export (.beads/issues.jsonl)",
    ]);
  });

  test("an export that doesn't decode: failed, naming the file", () => {
    const run = assess(config(), loaded(NO_BD, { invalid: "line 3 is not JSON" }), {}, ["beads"]);
    expect(run.reports[0]?.outcome.state).toBe("failed");
    expect(run.result.failing.map((v) => [v.rule, v.file])).toEqual([
      ["beads/export-unreadable", ".beads/issues.jsonl"],
    ]);
  });

  test("refs/bead-in-code runs on the export's ids; the memory budgets stay skipped", () => {
    const snapshot = {
      ...loaded(NO_BD, [bead("x-1", "open", ["track:a"])]),
      texts: new Map([["src/a.ts", "// see x-1\n"]]),
    };
    const run = assess(config(), snapshot, {}, ["refs"]);
    expect(run.result.failing.map((v) => v.rule)).toEqual(["refs/bead-in-code"]);
  });
});

describe("parseBeadsExport", () => {
  test("issues become beads; other record types are skipped; blank lines are fine", () => {
    const text = [
      JSON.stringify({
        _type: "issue",
        id: "x-1",
        title: "t",
        status: "open",
        issue_type: "bug",
        labels: ["track:a"],
        priority: 1,
      }),
      "",
      JSON.stringify({ _type: "memory", key: "k", value: "v" }),
      JSON.stringify({ id: "x-2", status: "closed" }),
    ].join("\n");
    expect(parseBeadsExport(text)).toEqual({
      rows: [
        { id: "x-1", title: "t", status: "open", type: "bug", labels: ["track:a"] },
        { id: "x-2", title: "", status: "closed", type: "", labels: [] },
      ],
    });
  });

  test("a line that isn't JSON, or an issue without id and status, names its line", () => {
    expect(parseBeadsExport('{"id":"x-1","status":"open"}\n{oops')).toEqual({
      invalid: "line 2 is not JSON",
    });
    expect(parseBeadsExport('{"id":"x-1"}')).toEqual({
      invalid: "line 1 has no string `id` and `status`",
    });
  });
});
