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
 * free Markdown, with `###` for headings inside a section (`## ` in a fenced block is fine).
 */
import { MAIN_BRANCH, TRACK_NAME, trackBranch, trackLabel } from "./layout.ts";

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

export type Problems = { readonly problems: ReadonlyArray<string> };

/** `YYYY-MM-DD` naming a real day: `2026-02-29` and `2026-13-45` don't. */
const isDate = (date: string): boolean => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (match === null) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return days !== undefined && day >= 1 && day <= days;
};

const heading = (section: HandoffSection, date: string): string =>
  section === "State" ? `## State (${date})` : `## ${section}`;

export const handoffQueue = (track: string): string => `bd ready --label ${trackLabel(track)}`;

/**
 * The handoff `track new` writes: `date` is today, `YYYY-MM-DD`; `worktree` is shown as given.
 * Checked against the format here, so a bad name or date fails where it is passed in, not
 * later in `track list` or `/track`.
 */
export const stubHandoff = (
  track: string,
  date: string,
  worktree: string,
): { readonly text: string } | Problems => {
  const bodies: Record<HandoffSection, string> = {
    Charter: "",
    State: `No charter yet: the next \`/track\` session interviews the human for one, writes it above and
sets \`Status: active\`. Worktree \`${worktree}\` on \`${trackBranch(track)}\`, branched from \`${MAIN_BRANCH}\`.`,
    "Lessons not yet promoted": "None yet.",
    Traps: "None yet.",
    Messages: "None yet.",
  };
  const text = [
    `# Track: ${track}\nStatus: stub\nQueue: ${handoffQueue(track)}`,
    ...HANDOFF_SECTIONS.map((section) =>
      bodies[section] === ""
        ? heading(section, date)
        : `${heading(section, date)}\n\n${bodies[section]}`,
    ),
  ].join("\n\n");
  const parsed = parseHandoff(`${text}\n`);
  return "problems" in parsed ? parsed : { text: `${text}\n` };
};

/**
 * `## ` lines outside fenced code blocks, since a body may quote Markdown, and the line of a
 * fence still open at the end. Fences as CommonMark has them: at most three spaces of indent;
 * closed by the same character, at least as long, with nothing after it.
 */
const headingsOf = (lines: ReadonlyArray<string>) => {
  const headings: Array<{ readonly name: string; readonly line: number }> = [];
  let open: { readonly marker: string; readonly line: number } | undefined;
  lines.forEach((line, index) => {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    const marker = fence?.[1];
    if (marker !== undefined && open === undefined) open = { marker, line: index };
    else if (
      marker !== undefined &&
      open !== undefined &&
      marker[0] === open.marker[0] &&
      marker.length >= open.marker.length &&
      (fence?.[2] ?? "").trim() === ""
    )
      open = undefined;
    else if (open === undefined && line.startsWith("## "))
      headings.push({ name: line.slice(3).trim(), line: index });
  });
  return { headings, unclosedFence: open?.line };
};

/** The handoff, or every way the text departs from the format. */
export const parseHandoff = (text: string): Handoff | Problems => {
  const problems: Array<string> = [];
  const lines = text
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .split("\n");
  const { headings, unclosedFence } = headingsOf(lines);
  if (unclosedFence !== undefined)
    problems.push(
      `a code fence opened on line ${unclosedFence + 1} is never closed, which hides every heading after it: close it with a matching fence`,
    );
  const header = lines
    .slice(0, headings[0]?.line ?? lines.length)
    .map((line) => line.trim())
    .filter((line) => line !== "");

  const title = /^# Track: (\S+)$/.exec(header[0] ?? "");
  const track = title?.[1] ?? "";
  if (title === null)
    problems.push(`the first line must be \`# Track: <name>\`, found \`${header[0] ?? ""}\``);
  else if (!TRACK_NAME.test(track))
    problems.push(`track name \`${track}\` is not lowercase words joined by hyphens`);

  const field = (name: string): string | undefined => {
    const found = header.filter((line) => line.startsWith(`${name}:`));
    if (found.length > 1) problems.push(`\`${name}:\` appears ${found.length} times; keep one`);
    return found[0]?.slice(name.length + 1).trim();
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

  let stateDate: string | undefined;
  const names = headings.map(({ name }) => {
    const state = /^State(?:\s*\((.*)\))?$/.exec(name);
    if (state === null) return name;
    stateDate = state[1];
    return "State";
  });
  const sections: Partial<Record<HandoffSection, string>> = {};
  if (names.join("\n") !== HANDOFF_SECTIONS.join("\n"))
    problems.push(
      `sections must be exactly ${HANDOFF_SECTIONS.map((s) => `\`${heading(s, "YYYY-MM-DD")}\``).join(", ")}, in that order (use \`###\` for headings inside a section); found ${names.map((s) => `\`## ${s}\``).join(", ") || "none"}`,
    );
  else {
    if (stateDate === undefined)
      problems.push("the State heading needs a date: `## State (YYYY-MM-DD)`");
    else if (!isDate(stateDate))
      problems.push(
        `the State heading's date must be a real day as \`YYYY-MM-DD\`, found \`${stateDate}\``,
      );
    headings.forEach((found, index) => {
      const end = headings[index + 1]?.line ?? lines.length;
      sections[HANDOFF_SECTIONS[index] as HandoffSection] = lines
        .slice(found.line + 1, end)
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
    stateDate: stateDate ?? "",
    sections: sections as Record<HandoffSection, string>,
  };
};
