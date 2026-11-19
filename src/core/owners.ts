/**
 * Who owns which files, from the milestone plan, and what `track pr` does with it: the
 * "Other tracks' files" line in the Gate section, the owners it mails, and the lines a squash
 * onto a moved `main` would silently revert. The I/O is in `src/adapters/trackPr.ts`.
 */

import { parsePrBody } from "./conventions.ts";
import { matches } from "./glob.ts";
import { fencedLines } from "./markdown.ts";

/** The plan `track pr` reads ownership from, repo-relative, on the branch it merges into. */
export const PLAN_FILE = "plan/MILESTONE.md";
/** The heading the table sits under, and the table's header cells. */
export const OWNERS_HEADING = "File owners";
const HEADER = ["Path", "Track"] as const;

export interface OwnerRow {
  /** A glob over repo-relative paths. */
  readonly path: string;
  readonly track: string;
}

export interface FileOwners {
  readonly rows: ReadonlyArray<OwnerRow>;
  /** Rows skipped as malformed, each named for a note. */
  readonly skipped: ReadonlyArray<string>;
}

/** A track's name as a table row may give it: `main`, or a track. */
const OWNER = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const cells = (line: string): ReadonlyArray<string> | undefined => {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return undefined;
  return trimmed
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim().replace(/^`(.*)`$/, "$1"));
};

/**
 * The first table under the `### File owners` heading (text may follow, as the plan's
 * `### File owners (prs, z1u.10)`) whose header is `| Path | Track |`;
 * undefined when the plan has no such heading or table. A row that isn't two cells, a path
 * and a track name, is skipped and named in `skipped`.
 */
export const parseFileOwners = (plan: string): FileOwners | undefined => {
  const lines = plan.replaceAll("\r\n", "\n").split("\n");
  const { fenced } = fencedLines(lines);
  const at = lines.findIndex(
    (line, index) => !fenced[index] && new RegExp(`^###\\s+${OWNERS_HEADING}\\b`).test(line),
  );
  if (at === -1) return undefined;
  for (let index = at + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!fenced[index] && /^#{1,3}\s/.test(line)) return undefined;
    const header = fenced[index] ? undefined : cells(line);
    if (header === undefined || header.length !== 2) continue;
    if (header[0] !== HEADER[0] || header[1] !== HEADER[1]) continue;
    const rows: Array<OwnerRow> = [];
    const skipped: Array<string> = [];
    // The delimiter row, then the body until the first line that isn't a table row.
    for (const row of lines.slice(index + 2)) {
      const values = cells(row);
      if (values === undefined) break;
      const [path, track] = values;
      if (values.length === 2 && path !== undefined && path !== "" && OWNER.test(track ?? ""))
        rows.push({ path, track: track ?? "" });
      else skipped.push(row.trim());
    }
    return { rows, skipped };
  }
  return undefined;
};

/** The track owning `file`: the first row whose glob matches it, or undefined. */
export const ownerOf = (file: string, rows: ReadonlyArray<OwnerRow>): string | undefined =>
  rows.find((row) => matches(file, row.path))?.track;

export interface OwnedFile {
  readonly file: string;
  readonly owner: string;
}

/** The files `track` changes that another owner has, sorted by owner, then file. */
export const otherOwners = (
  files: ReadonlyArray<string>,
  rows: ReadonlyArray<OwnerRow>,
  track: string,
): ReadonlyArray<OwnedFile> =>
  files
    .flatMap((file) => {
      const owner = ownerOf(file, rows);
      return owner === undefined || owner === track ? [] : [{ file, owner }];
    })
    .sort((a, b) => a.owner.localeCompare(b.owner) || a.file.localeCompare(b.file));

const LINE_START = "Other tracks' files";

/** The Gate section's line naming them; undefined when there are none. */
export const ownersLine = (owned: ReadonlyArray<OwnedFile>): string | undefined =>
  owned.length === 0
    ? undefined
    : `${LINE_START} (from ${PLAN_FILE}'s ${OWNERS_HEADING}; track pr mails each owner): ${owned
        .map(({ file, owner }) => `\`${file}\` (${owner})`)
        .join(", ")}.`;

const LINE = new RegExp(`^${LINE_START} .*$`, "m");

/** `gate` with its owners line replaced by `line`, or removed when `line` is undefined. */
export const withOwnersLine = (gate: string, line: string | undefined): string => {
  const without = gate.replace(LINE, "").trimEnd();
  return line === undefined ? without : `${without}\n\n${line}`;
};

/** What the PR's body says was already named, so mailed: its Gate section's owners line. */
export const namedOwners = (body: string): ReadonlyArray<OwnedFile> => {
  const gate = parsePrBody(body).find((section) => section.name === "Gate")?.text ?? "";
  const line = LINE.exec(gate)?.[0] ?? "";
  return [...line.matchAll(/`([^`]+)` \(([a-z0-9-]+)\)/g)].map((match) => ({
    file: match[1] ?? "",
    owner: match[2] ?? "",
  }));
};

/**
 * Whom to mail and about which files: each owner with a file `now` names that `before` didn't,
 * with all of its files, so a push that touches the same set mails no one.
 */
export const ownerNotices = (
  before: ReadonlyArray<OwnedFile>,
  now: ReadonlyArray<OwnedFile>,
): ReadonlyMap<string, ReadonlyArray<string>> => {
  const seen = new Set(before.map(({ file, owner }) => `${owner}\0${file}`));
  const byOwner = new Map<string, Array<string>>();
  for (const { file, owner } of now) byOwner.set(owner, [...(byOwner.get(owner) ?? []), file]);
  return new Map(
    [...byOwner].filter(([owner, files]) => files.some((file) => !seen.has(`${owner}\0${file}`))),
  );
};

/** The message an owner gets: its files, and that its next merge may conflict. */
export const ownerMessage = (
  pr: { readonly number: number; readonly url: string },
  track: string,
  files: ReadonlyArray<string>,
): { readonly subject: string; readonly body: string } => {
  const list = files.map((file) => `\`${file}\``).join(", ");
  const subject = `#${pr.number} from ${track} edits your files: ${list}`;
  return {
    subject:
      subject.length <= 120
        ? subject
        : `#${pr.number} from ${track} edits ${files.length} of your files`,
    body: [
      `Track ${track}'s PR ${pr.url} changes files the plan's ${OWNERS_HEADING} gives you: ${list}.`,
      "Your next merge with main may conflict there once it merges; the PR body says why it needed them.",
      "Sent by mshape track pr: reply only if this needs a decision from the track.",
    ].join("\n"),
  };
};

/** A line a diff adds or removes: its number on that side, and its text. */
export interface DiffLine {
  readonly line: number;
  readonly text: string;
}

/** A file's changes as `git diff -U0` gives them. */
export interface DiffLines {
  /** Each added line, numbered on the new side. */
  readonly added: ReadonlyArray<DiffLine>;
  /** Each removed line, numbered on the old side. */
  readonly removed: ReadonlyArray<DiffLine>;
}

/** `git diff -U0 --no-renames` output, by the new path (the old one for a deleted file). */
export const parseDiff = (diff: string): ReadonlyMap<string, DiffLines> => {
  const files = new Map<string, { added: Array<DiffLine>; removed: Array<DiffLine> }>();
  let current: { added: Array<DiffLine>; removed: Array<DiffLine> } | undefined;
  let oldPath = "";
  let old = 0;
  let added = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = undefined;
      continue;
    }
    if (line.startsWith("--- ")) {
      oldPath = line.slice(4).replace(/^a\//, "");
      continue;
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4) === "/dev/null" ? oldPath : line.slice(4).replace(/^b\//, "");
      current = { added: [], removed: [] };
      files.set(path, current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      old = Number(hunk[1]);
      added = Number(hunk[2]);
      continue;
    }
    if (current === undefined) continue;
    if (line.startsWith("-")) current.removed.push({ line: old++, text: line.slice(1) });
    else if (line.startsWith("+")) current.added.push({ line: added++, text: line.slice(1) });
  }
  return files;
};

export interface Reverted {
  readonly file: string;
  /** Line numbers on `main`'s side, at the branch's merge base. */
  readonly lines: ReadonlyArray<number>;
}

/**
 * Lines `main` gained since an earlier head of the branch forked from it that the tip now
 * removes, in files `ours` doesn't say are the track's. By position, not text: `gained` is the
 * diff between the two merge bases, so its added lines are numbered in the tip's merge base,
 * and `removing`, the diff from that merge base to the tip, numbers its removed lines there
 * too. A removal of an equal line elsewhere (a `}`, a table rule) is the track's own.
 */
export const revertedLines = (
  gained: ReadonlyMap<string, DiffLines>,
  removing: ReadonlyMap<string, DiffLines>,
  ours: (file: string) => boolean,
): ReadonlyArray<Reverted> =>
  [...removing].flatMap(([file, diff]) => {
    if (ours(file)) return [];
    const added = new Set((gained.get(file)?.added ?? []).map(({ line }) => line));
    const lines = diff.removed.filter(({ line }) => added.has(line)).map(({ line }) => line);
    return lines.length === 0 ? [] : [{ file, lines }];
  });

/** Line numbers as ranges: `3-5, 9`. */
const ranges = (lines: ReadonlyArray<number>): string => {
  const out: Array<string> = [];
  let start = lines[0];
  let end = start;
  for (const line of [...lines.slice(1), undefined]) {
    if (line !== undefined && end !== undefined && line === end + 1) end = line;
    else {
      if (start !== undefined) out.push(start === end ? `${start}` : `${start}-${end}`);
      start = line;
      end = line;
    }
  }
  return out.join(", ");
};

/** Why `track pr` refuses a push that reverts what `main` gained. */
export const revertedProblem = (
  reverted: ReadonlyArray<Reverted>,
  /** The tip's merge base with main, where the line numbers are. */
  base: string,
  /** The earlier head, and its merge base with main. */
  oldHead: string,
  oldBase: string,
): string =>
  `the branch was rewritten (its earlier head ${oldHead.slice(0, 12)} isn't in the tip's history), and the tip removes lines main gained since that head forked from it, in files this track doesn't own: ${reverted
    .map(({ file, lines }) => `${file} (lines ${ranges(lines)} at ${base.slice(0, 12)})`)
    .join(
      "; ",
    )}. A squash onto a moved main does this. Rebuild the squash on that head's merge base (\`git reset --soft ${oldBase.slice(0, 12)}\`, then commit), then merge main in (\`git merge origin/main\`). If removing them is the point, remove them in a commit on top of that: only a rewrite is checked`;
