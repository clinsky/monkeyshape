/**
 * `mshape track pr`'s decisions: what goes in the PR body it writes, and what it refuses. It
 * fills only what it verified itself (the Gate section, from a run it just did); every other
 * section is the agent's, kept as written. The sections are `PR_SECTIONS`, in conventions.ts.
 */
import {
  missingPrSections,
  type PrSectionName,
  parsePrBody,
  setPrSections,
} from "./conventions.ts";

/** Lines of the gate's output that go in the body: its summary is at the end. */
export const GATE_TAIL_LINES = 15;

/** Added plus deleted, from `git diff --shortstat`; 0 for no changes. */
export const changedLines = (shortstat: string): number => {
  const count = (what: string) => Number(new RegExp(`(\\d+) ${what}`).exec(shortstat)?.[1] ?? 0);
  return count("insertion") + count("deletion");
};

/**
 * The Gate section: the command, the commit it ran on, and the tail of its output, colour codes
 * removed, in a fence longer than any backtick run inside, so the output can't close it.
 */
export const gateSection = (command: string, commit: string, output: string): string => {
  const tail = gateTail(output);
  const longest = Math.max(2, ...[...tail.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  return `${fence}\n$ ${command}   # at ${commit.slice(0, 12)}, run by mshape track pr\n${tail}\n${fence}`;
};

/** The gate output's last `GATE_TAIL_LINES` lines, without terminal colour codes. */
export const gateTail = (output: string): string =>
  output
    // Terminal colour codes (biome's, say) are noise in a PR body.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\r\n/g, "\n")
    .trimEnd()
    .split("\n")
    .slice(-GATE_TAIL_LINES)
    .join("\n");

/** A bead id as bd writes them: `<prefix>-<hash>`, then `.<n>` per child level. */
const BEAD_ID = /^[a-z0-9][a-z0-9_]*(?:-[a-z0-9_]+)*-[a-z0-9]+(?:\.\d+)*$/;

/**
 * The bead ids the Beads section lists: the first word of each list item, with a link's
 * text for the link and emphasis or backticks stripped. Prose around them is free; an id is
 * only ever the start of an item.
 */
export const listedBeads = (body: string): ReadonlyArray<string> => {
  const text = parsePrBody(body).find((section) => section.name === "Beads")?.text ?? "";
  return text.split("\n").flatMap((line) => {
    const word = /^\s*(?:[-*+]|\d+[.)])\s+(\S+)/
      .exec(line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"))?.[1]
      // Emphasis and code around the id, and punctuation after it: `id`, **id**, _id_:
      ?.replace(/^[`*_]+|[`*_]*[.,:;]?$/g, "");
    return word !== undefined && BEAD_ID.test(word) ? [word] : [];
  });
};

export type PrBodyPlan =
  | { readonly body: string; readonly beads: ReadonlyArray<string> }
  | { readonly problems: ReadonlyArray<string> };

/**
 * Why a PR body isn't ready: a required section missing, or no bead listed. The one test,
 * run by `track pr` before it posts and by CI's pr.yml (`--check-body`) on every track PR,
 * however it was opened. Whether a listed bead exists needs `bd`, so only `track pr` asks.
 */
export const bodyProblems = (body: string): ReadonlyArray<string> => {
  const missing = missingPrSections(body);
  return [
    ...(missing.length > 0 ? [missingSectionsProblem(missing)] : []),
    ...(listedBeads(body).length === 0 && !missing.includes("Beads")
      ? [
          "the Beads section lists no bead: put each one this PR works on as a list item that starts with its id (`- <bead id> what it is`)",
        ]
      : []),
  ];
};

/**
 * The body to publish: the agent's (from --body-file) or the PR's current one, with the Gate
 * section replaced by `gate`, unless `bodyProblems` says it isn't ready.
 */
export const planPrBody = (source: string, gate: string): PrBodyPlan => {
  const body = setPrSections(source, { Gate: gate } satisfies Partial<
    Record<PrSectionName, string>
  >);
  const problems = bodyProblems(body);
  return problems.length > 0 ? { problems } : { body, beads: listedBeads(body) };
};

/** What `pr.yml` and `track pr` say about a body that lacks required sections. */
export const missingSectionsProblem = (missing: ReadonlyArray<string>): string =>
  `the PR body lacks ${missing.map((name) => `\`## ${name}\``).join(", ")}: add each heading with its text (a heading with only the template's placeholder counts as missing). The sections and what goes in each are in .github/pull_request_template.md`;
