/**
 * The handoff: one Markdown file per track, written by `mshape track new` as a stub and then
 * kept by the `track` and `handoff` skills. The shape, which `parseHandoff` enforces:
 *
 *   # Track: <name>
 *   Queue: bd ready --label track:<name>
 *
 *   ## Charter                     what the track is for; empty in a stub
 *   ## State (<YYYY-MM-DD>)        where the work stands; overwritten, not appended
 *   ## Lessons not yet promoted    learned here, not yet moved into a check, a doc or a decision
 *   ## Traps                       what will bite the next session
 *
 * A stub is a handoff with an empty charter: the next `/track` session interviews the human
 * for one and writes it. Nothing else records status, since done is derived from git, PRs and
 * beads. A charter opens with `Serves: ..., because ...`, then `Out of scope:` and
 * `Done means:`, each free to wrap onto the lines after it; anything below them is free.
 * Sections are in this order, each exactly once; their bodies are free Markdown, with `###`
 * for headings inside a section (`## ` in a fenced block is fine). Messages between tracks go
 * through `mshape msg`, not the handoff; `migrateHandoff` upgrades the older format.
 */
import { MAIN_BRANCH, TRACK_NAME, trackBranch, trackLabel } from "./layout.ts";
import { fencedLines } from "./markdown.ts";

export const HANDOFF_SECTIONS = ["Charter", "State", "Lessons not yet promoted", "Traps"] as const;
export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** The lines a charter opens with, in this order. */
export const CHARTER_LINES = ["Serves:", "Out of scope:", "Done means:"] as const;

export interface Handoff {
  readonly track: string;
  /** No charter yet: nobody has said what the track is for. */
  readonly stub: boolean;
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
    State: `No charter yet: the next \`/track\` session interviews the human for one and writes it above,
opening with ${CHARTER_LINES.map((line) => `\`${line}\``).join(", ")}. Worktree \`${worktree}\` on \`${trackBranch(track)}\`, branched from \`${MAIN_BRANCH}\`.`,
    "Lessons not yet promoted": "None yet.",
    Traps: "None yet.",
  };
  const text = [
    `# Track: ${track}\nQueue: ${handoffQueue(track)}`,
    ...HANDOFF_SECTIONS.map((section) =>
      bodies[section] === ""
        ? heading(section, date)
        : `${heading(section, date)}\n\n${bodies[section]}`,
    ),
  ].join("\n\n");
  const parsed = parseHandoff(`${text}\n`);
  return "problems" in parsed ? parsed : { text: `${text}\n` };
};

/** `## ` lines outside fenced code blocks, since a body may quote Markdown, and the line of a fence still open at the end. */
const headingsOf = (lines: ReadonlyArray<string>) => {
  const { fenced, unclosed } = fencedLines(lines);
  const headings = lines.flatMap((line, index) =>
    !fenced[index] && line.startsWith("## ") ? [{ name: line.slice(3).trim(), line: index }] : [],
  );
  return { headings, unclosedFence: unclosed };
};

/**
 * A charter is empty (a stub) or opens with `CHARTER_LINES` in order, each with a value, and
 * `Serves:` says why with `because`. A label starts a line; its value may wrap onto the next.
 */
const charterProblems = (charter: string): ReadonlyArray<string> => {
  if (charter === "") return [];
  const lines = charter.split("\n");
  const opening = CHARTER_LINES.map((label) => `\`${label} ...\``).join(", ");
  if (!lines[0]?.startsWith("Serves:"))
    return [
      `a charter opens with ${opening}, in that order; its first line is \`${lines[0]}\`: start it with \`Serves: <goal steps>, because <why this track, now>\``,
    ];
  const starts = CHARTER_LINES.map((label) => lines.findIndex((line) => line.startsWith(label)));
  const missing = CHARTER_LINES.filter((_, index) => (starts[index] ?? -1) < 0);
  if (missing.length > 0)
    return [
      `a charter opens with ${opening}; add ${missing.map((label) => `\`${label}\``).join(" and ")} after \`Serves:\``,
    ];
  if (starts.some((start, index) => index > 0 && start <= (starts[index - 1] ?? 0)))
    return [`a charter opens with ${opening}, in that order: reorder them`];
  const problems: Array<string> = [];
  CHARTER_LINES.forEach((label, index) => {
    const from = starts[index] ?? 0;
    // A value runs to the next label, or for the last one to the first blank line.
    const to = starts[index + 1] ?? lines.findIndex((line, at) => at > from && line.trim() === "");
    const value = lines
      .slice(from, to < 0 ? lines.length : to)
      .join(" ")
      .slice(label.length)
      .trim();
    if (value === "") problems.push(`the charter's \`${label}\` line is empty: say it`);
    else if (label === "Serves:" && !/\bbecause\b/.test(value))
      problems.push(
        "the charter's `Serves:` line says which goal steps and why, as `Serves: <goal steps>, because <why this track, now>`",
      );
  });
  return problems;
};

/**
 * A carried-over Messages body that says nothing: empty, or one paragraph opening with `None`
 * (`None yet.`, `None open. ...`). Anything more, such as a message added under `None yet.`,
 * is carried: an extra message costs less than one lost by a migration that runs once.
 */
const saysNothing = (body: string): boolean =>
  body === "" ||
  (/^none\b/i.test(body) &&
    body.split("\n").every((line) => line.trim() !== "" && !/^\s*([-*+]|\d+[.)]|#|>)/.test(line)));

/**
 * The older format, upgraded: the `Status:` line dropped, and the `## Messages` section
 * removed, its body returned as `carried` unless it said nothing, so the caller can mail it to
 * the track before writing `text`. Undefined when the text has neither, so a handoff is
 * migrated once. The result is not checked here: `parseHandoff` says what is still wrong.
 */
export const migrateHandoff = (
  text: string,
):
  | { readonly text: string; readonly changes: ReadonlyArray<string>; readonly carried?: string }
  | undefined => {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const { headings } = headingsOf(lines);
  const firstHeading = headings[0]?.line ?? lines.length;
  const status = lines.findIndex(
    (line, index) => index < firstHeading && /^Status:/.test(line.trim()),
  );
  const messages = headings.findIndex(({ name }) => name === "Messages");
  if (status < 0 && messages < 0) return undefined;
  const changes: Array<string> = [];
  let carried: string | undefined;
  let kept = lines;
  if (messages >= 0) {
    const from = headings[messages]?.line ?? 0;
    const to = headings[messages + 1]?.line ?? lines.length;
    const body = lines
      .slice(from + 1, to)
      .join("\n")
      .trim();
    if (!saysNothing(body)) carried = body;
    changes.push(
      carried === undefined
        ? "removed `## Messages`, which held nothing"
        : "moved `## Messages` into the track's mailbox",
    );
    kept = [...lines.slice(0, from), ...lines.slice(to)];
  }
  if (status >= 0) {
    changes.push(`removed \`${lines[status]?.trim()}\``);
    kept = kept.filter((_, index) => index !== status);
  }
  const migrated = `${kept.join("\n").trimEnd()}\n`;
  return carried === undefined ? { text: migrated, changes } : { text: migrated, changes, carried };
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
  const queue = field("Queue");
  if (title !== null && queue !== handoffQueue(track))
    problems.push(
      `the queue must be \`Queue: ${handoffQueue(track)}\`, found \`${queue ?? "(missing)"}\``,
    );
  const extra = header.slice(1).filter((line) => !line.startsWith("Queue:"));
  if (extra.some((line) => line.startsWith("Status:")))
    problems.push(
      "`Status:` is gone: a stub is a handoff with an empty charter, and done is derived. Run `mshape track list`, which migrates the old format",
    );
  else if (extra.length > 0)
    problems.push(
      `only \`Queue:\` goes between the title and \`## Charter\`; found \`${extra[0]}\``,
    );

  let stateDate: string | undefined;
  const names = headings.map(({ name }) => {
    const state = /^State(?:\s*\((.*)\))?$/.exec(name);
    if (state === null) return name;
    stateDate = state[1];
    return "State";
  });
  const sections: Partial<Record<HandoffSection, string>> = {};
  if (names.includes("Messages"))
    problems.push(
      "`## Messages` is gone: tracks message each other with `mshape msg send`. Run `mshape track list`, which moves the section into the track's mailbox",
    );
  else if (names.join("\n") !== HANDOFF_SECTIONS.join("\n"))
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
    problems.push(...charterProblems(sections.Charter ?? ""));
  }

  if (problems.length > 0) return { problems };
  return {
    track,
    stub: (sections.Charter ?? "") === "",
    queue: queue ?? "",
    stateDate: stateDate ?? "",
    sections: sections as Record<HandoffSection, string>,
  };
};
