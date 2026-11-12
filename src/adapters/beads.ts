/** The committed beads export, read where bd can't be, so CI checks beads without bd. */
import { Effect } from "effect";
import { BEADS_EXPORT, parseBeadsExport } from "../core/beads.ts";
import type { Snapshot } from "../core/model.ts";
import { readText } from "./workspace.ts";

/**
 * `snapshot` with its beads read from `.beads/issues.jsonl` when bd is unavailable and the
 * export is there; as it was otherwise. An export that doesn't decode is kept as invalid, for
 * the beads check to report.
 */
export const withBeadsExport = (root: string, snapshot: Snapshot) =>
  Effect.gen(function* () {
    if (snapshot.integrations.beads.state !== "unavailable") return snapshot;
    if (!(yield* Effect.promise(() => Bun.file(`${root}/${BEADS_EXPORT}`).exists())))
      return snapshot;
    const text = yield* readText(root, BEADS_EXPORT).pipe(
      Effect.map((read): string | undefined => read),
      Effect.orElseSucceed(() => undefined),
    );
    const parsed = text === undefined ? { invalid: "it can't be read" } : parseBeadsExport(text);
    if ("invalid" in parsed)
      return {
        ...snapshot,
        beadsExport: { path: BEADS_EXPORT, state: "invalid", reason: parsed.invalid },
      } satisfies Snapshot;
    return {
      ...snapshot,
      beadIds: new Set(parsed.rows.map((bead) => bead.id)),
      beadRows: parsed.rows,
      beadsExport: { path: BEADS_EXPORT, state: "read" },
    } satisfies Snapshot;
  });
