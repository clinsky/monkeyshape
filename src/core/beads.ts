/**
 * Who owns each bead, from bd alone (no GitHub): the facts `track list`, `track rm` and
 * `/milestone` decide by, held where they go wrong. An open bead no track owns is work nobody
 * does and no `track list` counts. A deferred or pinned bead with a track label is counted as that
 * track's open work, so the track is never done and `track rm` refuses. A `TODO(<id>)` naming
 * a closed bead says the work is pending after the bead said it was done.
 *
 * Outside tracks, a bead is owned by being an epic or a bd milestone (neither holds work of
 * its own), or by a label naming
 * the kind of work no track does: `milestone` (acceptance runs, planning) or `process` (the
 * loop itself). Ownership applies only in a repo that works in tracks, one where some bead,
 * open or closed, has carried a `track:` label: before its first tracks (a repo just born,
 * or one that doesn't use them) there is no owner to give. Needs bd: where it can't run,
 * the check is skipped with a notice.
 */
import type { BeadSummary, Snapshot, Violation } from "./model.ts";
import { isTsSource, lineAt } from "./model.ts";
import { parse } from "./parse.ts";

/** Every rule this check reports, as `beads/<kind>`; test/core/ruleCases.test.ts covers each. */
export const BEADS_RULES = ["unowned", "deferred-in-track", "todo-closed"] as const;

/** Labels that own a bead no track does. */
export const OWNER_LABELS = ["milestone", "process"] as const;

/**
 * bd's statuses for work set aside: `deferred` (later) and `pinned` (stays open on purpose).
 * Neither is a track's to do, so neither needs a track, and neither may keep one.
 */
const FROZEN: ReadonlyArray<string> = ["deferred", "pinned"];

/** bd's types that hold no work of their own: `epic` (spans tracks) and `milestone`. */
const UNOWNED_TYPES: ReadonlyArray<string> = ["epic", "milestone"];

/** Where the bead findings point: bd's own directory, since a bead has no file of its own. */
export const BEADS_FILE = ".beads";

const violation = (
  rule: (typeof BEADS_RULES)[number],
  file: string,
  message: string,
  line?: number,
): Violation => ({
  check: "beads",
  rule: `beads/${rule}`,
  file,
  ...(line === undefined ? {} : { line }),
  message,
});

const trackLabels = (bead: BeadSummary): ReadonlyArray<string> =>
  bead.labels.filter((label) => label.startsWith("track:"));

/** A bead's id, then its title in quotes, so the message names it without a lookup. */
const named = (bead: BeadSummary): string => `${bead.id} ("${bead.title}")`;

const TODO = /TODO\(([^)\s]+)\)/g;

export const checkBeads = (_config: unknown, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const beads = snapshot.beadRows;
  if (beads === undefined) return [];
  const violations: Array<Violation> = [];
  const inTracks = beads.some((bead) => trackLabels(bead).length > 0);
  for (const bead of beads) {
    const tracks = trackLabels(bead);
    if (
      inTracks &&
      bead.status !== "closed" &&
      !FROZEN.includes(bead.status) &&
      !UNOWNED_TYPES.includes(bead.type) &&
      tracks.length === 0 &&
      !bead.labels.some((label) => (OWNER_LABELS as ReadonlyArray<string>).includes(label))
    )
      violations.push(
        violation(
          "unowned",
          BEADS_FILE,
          `bead ${named(bead)} is ${bead.status}, but no track owns it, so no \`track list\` counts it. Give it to the track doing it (\`bd update ${bead.id} --add-label track:<name>\`), label work no track does \`milestone\` or \`process\`, or defer it (\`bd defer ${bead.id}\`)`,
        ),
      );
    if (FROZEN.includes(bead.status) && tracks.length > 0)
      violations.push(
        violation(
          "deferred-in-track",
          BEADS_FILE,
          `bead ${named(bead)} is ${bead.status} but still labelled ${tracks.map((t) => `\`${t}\``).join(", ")}, so it counts as that track's open work: the track is never done and \`track rm\` refuses. Remove the label (${tracks.map((t) => `\`bd update ${bead.id} --remove-label ${t}\``).join(", ")}), or undefer it if the track will do it now`,
        ),
      );
  }
  const closed = new Map(beads.filter((bead) => bead.status === "closed").map((b) => [b.id, b]));
  for (const file of snapshot.files) {
    if (!isTsSource(file)) continue;
    const text = snapshot.texts.get(file);
    if (text === undefined) continue;
    for (const comment of parse(file, text).comments)
      for (const match of comment.value.matchAll(TODO)) {
        const bead = closed.get(match[1] ?? "");
        if (bead === undefined) continue;
        violations.push(
          violation(
            "todo-closed",
            file,
            `\`TODO(${bead.id})\` names a closed bead ("${bead.title}"): do what it says and delete the TODO, delete it if the work is done, or reopen the bead (\`bd update ${bead.id} --status open\`) if it isn't`,
            // The TODO's own line, in a block comment too: `value` starts after `//` or `/*`.
            lineAt(text, comment.start + 2 + (match.index ?? 0)),
          ),
        );
      }
  }
  return violations;
};
