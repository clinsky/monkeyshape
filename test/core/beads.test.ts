import { describe, expect, test } from "bun:test";
import { checkBeads } from "../../src/core/beads.ts";
import type { BeadSummary } from "../../src/core/model.ts";
import { repo } from "../support.ts";

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
