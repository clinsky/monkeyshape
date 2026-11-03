/**
 * The working loop's machine-checkable conventions, each with one owner: this file. A value
 * lives here only if code or a check reads it; docs and skills word a convention for their
 * reader, and nothing renders them from here. The track branch and `main` are in `layout.ts`,
 * with the rest of where things live.
 *
 * The PR body: `PR_SECTIONS` is the one list. `.github/pull_request_template.md`, here and in
 * every repo `mshape init` creates, is `prTemplate()`, and a test fails when either drifts.
 * `mshape track pr` builds a new body with `prSkeleton` and refreshes the fields it knows with
 * `setPrSections`, which leaves every other section as the agent wrote it.
 */

import { fencedLines } from "./markdown.ts";

/** The package script that is the gate, the same locally and in CI. */
export const GATE_SCRIPT = "check";
/** The gate as a command: green before every PR. */
export const GATE_COMMAND = `bun run ${GATE_SCRIPT}`;

export interface PrSection {
  /** The `## ` heading, verbatim. */
  readonly name: string;
  /** What goes in it, for the agent writing it: the template's placeholder. */
  readonly purpose: string;
  /** CI fails a track's PR whose body lacks the heading. */
  readonly required: boolean;
}

/** The PR body's sections, in order. */
export const PR_SECTIONS = [
  {
    name: "What changed and why",
    purpose: "The narrative: what changed, why, and what a reviewer should look at first.",
    required: true,
  },
  {
    name: "Evidence",
    purpose: "What the change did on real data or a real target: commands and their output.",
    required: true,
  },
  {
    name: "Gate",
    purpose: `The tail of a fresh \`${GATE_COMMAND}\`.`,
    required: true,
  },
  {
    name: "Bug class closed",
    purpose: "For a new check or rule: the class of bug it removes. Otherwise delete this section.",
    required: false,
  },
  {
    name: "Not done",
    purpose: "What this PR leaves out, and why; the bead each follow-up is filed as.",
    required: true,
  },
  {
    name: "Beads",
    purpose: "The beads this PR works on, by id, and any it filed.",
    required: true,
  },
] as const satisfies ReadonlyArray<PrSection>;

export type PrSectionName = (typeof PR_SECTIONS)[number]["name"];

/**
 * A track's PRs batch beads of one theme into about this many changed lines (added plus
 * deleted): many small PRs cost more review than a few large ones. A default for batching,
 * not a gate.
 */
export const PR_SIZE = { min: 1000, max: 2500 } as const;

/** One line for whoever is about to open a PR: its size against the batching default. */
export const prSizeNote = (changedLines: number): string => {
  const range = `${PR_SIZE.min} to ${PR_SIZE.max} changed lines`;
  const where =
    changedLines < PR_SIZE.min
      ? "below the batching default; fine when it unblocks work or keeps docs in step with code"
      : changedLines > PR_SIZE.max
        ? "above the batching default; split it if it has more than one theme"
        : "within the batching default";
  return `${changedLines} changed lines: ${where} (${range}).`;
};

const heading = (name: string): string => `## ${name}`;

/**
 * Text without its blank first and last lines. Not `trim()`: a first line's indentation is
 * Markdown (an indented code block, a nested list item), and must survive a round trip.
 */
const trimLines = (text: string): string => text.replace(/^(?:[ \t]*\n)+/, "").trimEnd();
const placeholder = (section: PrSection): string => `<!-- ${section.purpose} -->`;
const fill = (value: string | undefined, section: PrSection): string =>
  value === undefined ? placeholder(section) : trimLines(value);

/**
 * A PR body with every section in order: the given text under its heading, the section's
 * placeholder under the rest.
 */
export const prSkeleton = (values: Partial<Record<PrSectionName, string>> = {}): string =>
  `${PR_SECTIONS.map(
    (section) => `${heading(section.name)}\n\n${fill(values[section.name], section)}`,
  ).join("\n\n")}\n`;

/** `.github/pull_request_template.md`: the skeleton with nothing filled in. */
export const prTemplate = (): string => prSkeleton();

/** Where GitHub reads the PR template, repo-relative. */
export const PR_TEMPLATE_FILE = ".github/pull_request_template.md";

export interface PrBodySection {
  readonly name: string;
  /** The text under the heading, without blank lines at either end. */
  readonly text: string;
}

/**
 * A PR body's `## ` sections in order, with the text before the first heading as a section
 * named "". Headings inside fenced code blocks are text.
 */
export const parsePrBody = (body: string): ReadonlyArray<PrBodySection> => {
  const sections: Array<{ name: string; lines: Array<string> }> = [{ name: "", lines: [] }];
  const lines = body.replaceAll("\r\n", "\n").split("\n");
  const { fenced } = fencedLines(lines);
  for (const [index, line] of lines.entries()) {
    const name = fenced[index] ? undefined : /^ {0,3}## +(.+?)(?: +#+)?\s*$/.exec(line)?.[1];
    if (name !== undefined) sections.push({ name, lines: [] });
    else sections[sections.length - 1]?.lines.push(line);
  }
  return sections
    .map((section) => ({ name: section.name, text: trimLines(section.lines.join("\n")) }))
    .filter((section) => section.name !== "" || section.text !== "");
};

/**
 * The required sections `body` lacks, in order. A heading with nothing under it but blank
 * lines and HTML comments (the template's placeholder) is missing: it was never filled in.
 */
export const missingPrSections = (body: string): ReadonlyArray<PrSectionName> => {
  const present = new Set(
    parsePrBody(body)
      .filter((section) => section.text.replace(/<!--[\s\S]*?-->/g, "").trim() !== "")
      .map((section) => section.name),
  );
  return PR_SECTIONS.filter((section) => section.required && !present.has(section.name)).map(
    (section) => section.name,
  );
};

/**
 * `body` with the given sections' text replaced, and every other section, including ones it
 * doesn't know, kept as written. A given section the body lacks goes in its place in
 * `PR_SECTIONS` order, after the last known section that precedes it.
 */
export const setPrSections = (
  body: string,
  values: Partial<Record<PrSectionName, string>>,
): string => {
  const sections = parsePrBody(body).map((section) => ({ ...section }));
  for (const [index, known] of PR_SECTIONS.entries()) {
    const value = values[known.name];
    if (value === undefined) continue;
    const text = trimLines(value);
    const existing = sections.find((section) => section.name === known.name);
    if (existing !== undefined) {
      existing.text = text;
      continue;
    }
    const before = new Set(PR_SECTIONS.slice(0, index).map((section) => section.name as string));
    const after = sections.findLastIndex((section) => before.has(section.name));
    const at = after === -1 ? (sections[0]?.name === "" ? 1 : 0) : after + 1;
    sections.splice(at, 0, { name: known.name, text });
  }
  return `${sections
    .map((section) =>
      section.name === "" ? section.text : `${heading(section.name)}\n\n${section.text}`.trimEnd(),
    )
    .join("\n\n")}\n`;
};

/**
 * What monkeyshape decides for every repo, loaded at each session start: bd's SessionStart
 * hook prints this file in place of its own default text, then the repo's memories. The
 * package ships it as `template/.beads/PRIME.md`; `mshape sync` installs it and the `sync`
 * check holds it to the shipped copy.
 */
export const PRIME_FILE = ".beads/PRIME.md";
/** PRIME.md's budget: it costs every session. */
export const PRIME_LINES = 70;
