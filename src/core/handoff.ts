/**
 * The handoff: one Markdown file per track, written by `mshape track new` as a stub and then
 * kept by the `track` and `handoff` skills. The shape, which `parseHandoff` enforces:
 *
 *   # Track: <name>
 *   Status: stub | active
 *   Queue: bd ready --label track:<name>
 *
 *   ## Charter                     what the track is for; empty in a stub
 *   ## State (<YYYY-MM-DD>)        where the work stands; overwritten, not appended
 *   ## Lessons not yet promoted    learned here, not yet moved into a check, a doc or a decision
 *   ## Traps                       what will bite the next session
 *   ## Messages                    to and from other tracks
 *
 * A stub has no charter: the next `/track` session interviews the human for one, writes it,
 * and sets `Status: active`. Sections are in this order, each exactly once; their bodies are
 * free Markdown.
 */
import { TRACK_NAME, trackLabel } from "./layout.ts";

export type HandoffStatus = "stub" | "active";

export const HANDOFF_SECTIONS = [
  "Charter",
  "State",
  "Lessons not yet promoted",
  "Traps",
  "Messages",
] as const;
export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

export interface Handoff {
  readonly track: string;
  readonly status: HandoffStatus;
  readonly queue: string;
  /** The date in the State heading. */
  readonly stateDate: string;
  /** Each section's body, trimmed. */
  readonly sections: Readonly<Record<HandoffSection, string>>;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export const handoffQueue = (track: string): string => `bd ready --label ${trackLabel(track)}`;

/** The handoff `track new` writes. `date` is today, `YYYY-MM-DD`; `worktree` is shown as given. */
export const stubHandoff = (track: string, date: string, worktree: string): string =>
  `# Track: ${track}
Status: stub
Queue: ${handoffQueue(track)}

## Charter

## State (${date})

No charter yet: the next \`/track\` session interviews the human for one, writes it above and
sets \`Status: active\`. Worktree \`${worktree}\` on \`track/${track}\`, branched from \`main\`.

## Lessons not yet promoted

None yet.

## Traps

None yet.

## Messages

None yet.
`;

/** The handoff, or every way the text departs from the format. */
export const parseHandoff = (
  text: string,
): Handoff | { readonly problems: ReadonlyArray<string> } => {
  const problems: Array<string> = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const firstSection = lines.findIndex((line) => line.startsWith("## "));
  const header = (firstSection === -1 ? lines : lines.slice(0, firstSection)).filter(
    (line) => line.trim() !== "",
  );

  const title = /^# Track: (\S+)$/.exec(header[0] ?? "");
  const track = title?.[1] ?? "";
  if (title === null) problems.push("the first line must be `# Track: <name>`");
  else if (!TRACK_NAME.test(track))
    problems.push(`track name \`${track}\` is not lowercase words joined by hyphens`);

  const field = (name: string): string | undefined => {
    const line = header.find((candidate) => candidate.startsWith(`${name}:`));
    return line?.slice(name.length + 1).trim();
  };
  const status = field("Status");
  if (status !== "stub" && status !== "active")
    problems.push(`\`Status:\` must be \`stub\` or \`active\`, found \`${status ?? "(missing)"}\``);
  const queue = field("Queue");
  if (title !== null && queue !== handoffQueue(track))
    problems.push(
      `the queue must be \`Queue: ${handoffQueue(track)}\`, found \`${queue ?? "(missing)"}\``,
    );
  const extra = header.slice(1).filter((line) => !/^(Status|Queue):/.test(line));
  if (extra.length > 0)
    problems.push(
      `only \`Status:\` and \`Queue:\` go between the title and \`## Charter\`; found \`${extra[0]}\``,
    );

  const headings: Array<{ readonly name: string; readonly line: number }> = [];
  lines.forEach((line, index) => {
    if (line.startsWith("## ")) headings.push({ name: line.slice(3).trim(), line: index });
  });
  let stateDate = "";
  const sections: Partial<Record<HandoffSection, string>> = {};
  const names = headings.map(({ name }) => {
    const state = /^State \((.*)\)$/.exec(name);
    if (state === null) return name;
    stateDate = state[1] ?? "";
    return "State";
  });
  if (names.join("\n") !== HANDOFF_SECTIONS.join("\n"))
    problems.push(
      `sections must be exactly ${HANDOFF_SECTIONS.map((s) => `\`## ${s === "State" ? "State (<date>)" : s}\``).join(", ")}, in that order; found ${names.map((s) => `\`## ${s}\``).join(", ") || "none"}`,
    );
  else {
    if (!DATE.test(stateDate))
      problems.push(`the State heading's date must be \`YYYY-MM-DD\`, found \`${stateDate}\``);
    headings.forEach((heading, index) => {
      const end = headings[index + 1]?.line ?? lines.length;
      sections[HANDOFF_SECTIONS[index] as HandoffSection] = lines
        .slice(heading.line + 1, end)
        .join("\n")
        .trim();
    });
    const charter = sections.Charter ?? "";
    if (status === "stub" && charter !== "")
      problems.push("a stub has an empty charter: write the charter and set `Status: active`");
    if (status === "active" && charter === "")
      problems.push("an active track needs a charter; until it has one, its status is `stub`");
  }

  if (problems.length > 0) return { problems };
  return {
    track,
    status: status as HandoffStatus,
    queue: queue ?? "",
    stateDate,
    sections: sections as Record<HandoffSection, string>,
  };
};
