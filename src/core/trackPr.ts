/**
 * `mshape track pr`'s decisions: what goes in the PR body it writes, and what it refuses. It
 * fills only what it verified itself (the Gate section, from a run it just did); every other
 * section is the agent's, kept as written. The sections are `PR_SECTIONS`, in conventions.ts.
 */
import {
  GATE_COMMAND,
  GATE_FAST_COMMAND,
  GATE_SCRIPT,
  missingPrSections,
  type PrSectionName,
  parsePrBody,
  setPrSections,
} from "./conventions.ts";
import { MAIN_BRANCH, worktreesDir } from "./layout.ts";

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
export const gateSection = (
  command: string,
  commit: string,
  output: string,
  /** CI's line (`ciLine`), when CI runs the tests this run left out. */
  ci?: string,
): string => {
  const tail = gateTail(output);
  const longest = Math.max(2, ...[...tail.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = "`".repeat(longest + 1);
  const block = `${fence}\n$ ${command}   # at ${commit.slice(0, 12)}, run by mshape track pr\n${tail}\n${fence}`;
  return ci === undefined ? block : `${block}\n\n${ci}`;
};

/**
 * What `track pr` runs before it pushes: `fast`, the gate's fast phase, when a workflow runs
 * the whole gate on pull requests, so CI runs the rest on the pushed commit and a push blocks
 * for seconds, not minutes; `full`, the whole gate, in a repo with no such workflow. Never by
 * file type: prose is test input too.
 */
export type GatePlan = { readonly kind: "fast" } | { readonly kind: "full" };

/** A workflow without its comments: `#` to the line's end, at its start or after a space. */
const uncommented = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, ""))
    .join("\n");

/** The items `key` lists in `block`: inline (`key: [a, b]`) or as `- item` lines under it. */
const listed = (block: string, key: string): ReadonlyArray<string> | undefined => {
  const clean = (item: string) => item.trim().replace(/^["']|["']$/g, "");
  const inline = new RegExp(`(?:^|[\\s{,])${key}\\s*:\\s*\\[([^\\]]*)\\]`).exec(block)?.[1];
  if (inline !== undefined)
    return inline
      .split(",")
      .map(clean)
      .filter((item) => item !== "");
  const lines = block.split("\n");
  const at = lines.findIndex((line) => new RegExp(`^\\s*${key}\\s*:`).test(line));
  if (at === -1) return undefined;
  const scalar = (lines[at] ?? "").replace(new RegExp(`^\\s*${key}\\s*:`), "").trim();
  if (scalar !== "") return [clean(scalar)];
  const items: Array<string> = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line)?.[1];
    if (item === undefined) break;
    items.push(clean(item));
  }
  return items;
};

/**
 * Whether a `pull_request` trigger's filters let it run on every PR into `main` on every push:
 * no `paths` or `paths-ignore`, no `branches-ignore`, `branches` (if any) listing `main`, and
 * `types` (if any) including `synchronize`, which a pushed fix sends.
 */
const everyPr = (block: string): boolean => {
  if (/(?:^|[\s{,])(paths|paths-ignore|branches-ignore)\s*:/m.test(block)) return false;
  const branches = listed(block, "branches");
  if (branches !== undefined && !branches.includes(MAIN_BRANCH)) return false;
  const types = listed(block, "types");
  return types === undefined || types.includes("synchronize");
};

/**
 * The whole gate as a workflow step runs it: `mshape gate` (however mshape is reached, as
 * `bun run --silent mshape gate` does) but not its `--fast` phase, or a TypeScript repo's
 * `bun run check` alias of it.
 */
const runsGate = new RegExp(
  `(?:^|[\\s"'])(?:${GATE_COMMAND}(?![ \\t]+--fast)|bun run ${GATE_SCRIPT})(?=$|[\\s"'&;|])`,
  "m",
);

/**
 * Whether a workflow runs the gate on every pull request: a `pull_request` trigger whose
 * filters let every PR and every push through (`everyPr`), and the gate as a whole command,
 * not a longer script's name. Comments are ignored.
 */
export const workflowRunsGate = (workflow: string): boolean => {
  const text = uncommented(workflow);
  if (!runsGate.test(text)) return false;
  const lines = text.split("\n");
  const at = lines.findIndex((line) => /(^|[\s[,])pull_request\b/.test(line));
  if (at === -1) return false;
  const line = lines[at] ?? "";
  // An inline map: `pull_request: { ... }`.
  const inline = /pull_request\s*:\s*(\{.*\})/.exec(line)?.[1];
  if (inline !== undefined) return everyPr(inline);
  // `pull_request:` opens a block: what is indented under it filters it.
  const key = /^(\s*)pull_request\s*:\s*$/.exec(line);
  if (key === null) return true;
  const indent = key[1]?.length ?? 0;
  const block: Array<string> = [];
  for (const next of lines.slice(at + 1)) {
    if (next.trim() === "") continue;
    if ((/^\s*/.exec(next)?.[0].length ?? 0) <= indent) break;
    block.push(next);
  }
  return everyPr(block.join("\n"));
};

/**
 * The checks CI's gate makes on a PR's head: in each workflow that runs the gate on every PR,
 * the jobs whose steps run it, each by its `name:` if it has one, else its key. A matrix job's
 * runs are named `<name> (<values>)`; `ciState` matches either.
 */
export const gateChecks = (workflows: ReadonlyArray<string>): ReadonlyArray<string> =>
  workflows.filter(workflowRunsGate).flatMap((workflow) => {
    const lines = uncommented(workflow).split("\n");
    const at = lines.findIndex((line) => /^jobs\s*:\s*$/.test(line));
    if (at === -1) return [];
    const jobs: Array<{ key: string; lines: Array<string> }> = [];
    for (const line of lines.slice(at + 1)) {
      if (line.trim() === "") continue;
      if (!/^\s/.test(line)) break;
      const key = /^ {2}([\w-]+)\s*:\s*$/.exec(line)?.[1];
      if (key !== undefined) jobs.push({ key, lines: [] });
      else jobs.at(-1)?.lines.push(line);
    }
    // Only what can be predicted: a job-level `if:` may keep the job off a PR entirely, and a
    // name with an expression (`gate ${{ matrix.os }}`) is named on GitHub as it evaluates.
    // Either is skipped, and --wait waits for any new run there, as with no gate job found.
    return jobs
      .filter((job) => runsGate.test(job.lines.join("\n")))
      .filter((job) => !job.lines.some((line) => /^ {4}if\s*:/.test(line)))
      .flatMap((job) => {
        const named = job.lines
          .map((line) => /^ {4}name\s*:\s*(.+?)\s*$/.exec(line)?.[1])
          .find((name) => name !== undefined);
        if (named === undefined) return [job.key];
        return named.includes("${{") ? [] : [named.replace(/^["']|["']$/g, "")];
      });
  });

export const gatePlan = (
  /** The text of each workflow under `.github/workflows`. */
  workflows: ReadonlyArray<string>,
): GatePlan => (workflows.some(workflowRunsGate) ? { kind: "fast" } : { kind: "full" });

/** How a gate plan reads as a command, for the Gate section and what track pr says. */
export const gatePlanCommand = (plan: GatePlan): string =>
  plan.kind === "full" ? GATE_COMMAND : GATE_FAST_COMMAND;

/**
 * The Gate section's CI line, when CI runs the tests: pending at the push, then CI's verdict
 * on the pushed commit once `--wait` has it, each check with its run's link.
 */
export const ciLine = (commit: string, runs?: ReadonlyArray<CheckRun>): string =>
  runs === undefined
    ? `CI: runs the whole gate on ${commit.slice(0, 12)}, not track pr; \`mshape track pr --wait\` records its result here.`
    : `CI on ${commit.slice(0, 12)}: ${runs
        .map(
          (run) =>
            `${run.name}: ${run.conclusion ?? run.status}${run.html_url === undefined ? "" : ` ([run](${run.html_url}))`}`,
        )
        .join(", ")}.`;

/** `gate` with its CI line replaced by `line`; undefined when it has none to replace. */
export const withCiLine = (gate: string, line: string): string | undefined =>
  /^CI(?: on [0-9a-f]+)?: .*$/m.test(gate)
    ? gate.replace(/^CI(?: on [0-9a-f]+)?: .*$/m, line)
    : undefined;

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
 * What CI's pr.yml (`--check-body`) holds every track PR to, however it was opened: the
 * required sections, as the template names them. Nothing more, so a body that follows the
 * template passes, whatever form its Beads section takes.
 */
export const headingProblems = (body: string): ReadonlyArray<string> => {
  const missing = missingPrSections(body);
  return missing.length > 0 ? [missingSectionsProblem(missing)] : [];
};

/**
 * What `track pr` holds a body to before it posts: `headingProblems`, and beads it can read.
 * It goes further than CI on purpose: it checks each listed bead with `bd`, so it needs them
 * as list items starting with their id, and says so. CI can't run `bd`, and the template
 * doesn't ask for that form, so CI doesn't refuse a body for it (#33's `<id>.` passes there).
 */
export const bodyProblems = (body: string): ReadonlyArray<string> => [
  ...headingProblems(body),
  ...(listedBeads(body).length === 0 && !missingPrSections(body).includes("Beads")
    ? [
        "the Beads section lists no bead: put each one this PR works on as a list item that starts with its id (`- <bead id> what it is`)",
      ]
    : []),
];

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

/**
 * Where `track pr` gates: a detached checkout of the tip beside the tracks, so nothing
 * untracked or ignored in the track's worktree can pass a gate the pushed commit fails. It
 * sits under the worktrees directory so dependency lookups that walk up reach the repo.
 */
export const gateCheckoutPath = (repo: string, track: string): string => {
  const root = repo.replace(/\/+$/, "");
  return `${worktreesDir(root)}/${root.slice(root.lastIndexOf("/") + 1)}.gate-${track}`;
};

/** The last gate run's whole output, kept inside git's directory, never committed. */
export const gateLogPath = (common: string, track: string): string =>
  `${common.replace(/\/+$/, "")}/monkeyshape/gate/${track}.log`;

/** The tests a gate run names as failed: bun's `(fail) <describe> > <test>` lines. */
export const failingTests = (output: string): ReadonlyArray<string> =>
  output
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the point
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("(fail) "))
    .map((line) => line.slice("(fail) ".length).replace(/ \[[0-9.]+m?s\]$/, ""));

/**
 * What `mshape review post` adds to every review it posts, hidden when GitHub renders it, so
 * `track pr` can tell a reviewer's review from anything else on the PR.
 */
export const REVIEW_MARKER = "<!-- posted by mshape review post -->";

/** A review as GitHub lists it: thread replies are reviews too, with an empty body. */
export interface PostedReview {
  readonly commit_id: string;
  readonly body: string;
}

/**
 * Whether a reviewer has posted on `head`. A thread reply is a review with an empty body (the
 * author answering findings makes one), so it never counts. Once any review carries
 * `REVIEW_MARKER`, only marked ones count, since the author's account may be the reviewer's;
 * before then, any review with a body does, as a reviewer posting by hand leaves no mark.
 */
export const reviewedHead = (reviews: ReadonlyArray<PostedReview>, head: string): boolean => {
  const marked = reviews.filter((review) => review.body.includes(REVIEW_MARKER));
  const counted =
    marked.length > 0 ? marked : reviews.filter((review) => review.body.trim() !== "");
  return counted.some((review) => review.commit_id === head);
};

/** What `track pr` knows about a review of its PR on this machine. */
export interface ReviewFacts {
  readonly pr: number;
  /** Where its reviewer is: `review-<track>` while this PR is the track's under review, else `review-<n>`. */
  readonly address: string;
  /** Live sessions registered at `address`. */
  readonly live: ReadonlyArray<string>;
  /** Whether any session was ever registered there and is still recorded, live or not. */
  readonly registered: boolean;
  /** Whether a review on the PR has the PR's head as its `commit_id`. */
  readonly reviewedHead: boolean;
  /** Whether the push would change the PR's head: false when the tip already is it. */
  readonly moves: boolean;
}

/**
 * Whether `track pr` may push. A review is in progress while a live session is registered
 * at the reviewer's address and no review has the PR's head as its commit: no clock, since
 * commit dates are the author's. Once a review is on the head, its findings are there to answer.
 * A push that leaves the head where it is (`--wait` on a tip already pushed) changes nothing
 * under the reviewer, so it is never refused.
 */
export const reviewDecision = (
  facts: ReviewFacts,
): { readonly refuse: string } | { readonly note: string | undefined } => {
  const { address } = facts;
  if (facts.live.length > 0 && !facts.reviewedHead && facts.moves)
    return {
      refuse: `a review of #${facts.pr} is in progress (session ${facts.live.join(", ")} at \`${address}\`) and hasn't posted on the PR's head yet, so nothing was pushed or posted: a push now would change the PR under its reviewer. Wait for the review, then answer it; keep new work on a local branch meanwhile`,
    };
  if (facts.live.length > 0) return { note: undefined };
  if (facts.registered && !facts.reviewedHead)
    return {
      note: `note: a reviewer's session at \`${address}\` ended without posting a review on the PR's head; pushing`,
    };
  return {
    note: `note: no review of #${facts.pr} is in progress on this machine; a reviewer on another machine can't be seen from here`,
  };
};

/** The commit the Gate section says it ran on: `# at <sha>, run by mshape track pr`. */
export const gatedCommit = (body: string): string | undefined =>
  /# at ([0-9a-f]{7,40}), run by mshape track pr/.exec(
    parsePrBody(body).find((section) => section.name === "Gate")?.text ?? "",
  )?.[1];

/**
 * `--body-only`: the body may change without a push or a gate only while the Gate section is
 * still true, so the branch's tip, the PR's head and the commit the Gate section names are one.
 */
export const bodyOnlyProblem = (facts: {
  readonly tip: string;
  readonly head: string;
  readonly gated: string | undefined;
}): string | undefined => {
  if (facts.gated === undefined)
    return "--body-only keeps the Gate section, and the PR's body has none written by track pr: run track pr without --body-only";
  if (!facts.tip.startsWith(facts.gated) || facts.head !== facts.tip)
    return `--body-only would leave the Gate section false: it ran on ${facts.gated}, the PR's head is ${facts.head.slice(0, 12)} and the branch's tip ${facts.tip.slice(0, 12)}. Run track pr without --body-only to gate and push the tip`;
  return undefined;
};

/** The warning when the tip is behind the branch it merges into, or conflicts with it. */
export const behindWarning = (facts: {
  readonly target: string;
  readonly behind: number;
  /** Files that conflict when merging the target in; undefined when git couldn't say. */
  readonly conflicts: ReadonlyArray<string> | undefined;
}): string | undefined => {
  if (facts.behind === 0) return undefined;
  const conflict =
    facts.conflicts === undefined || facts.conflicts.length === 0
      ? ""
      : `, and conflicts with it in ${facts.conflicts.slice(0, 5).join(", ")}${facts.conflicts.length > 5 ? ", ..." : ""}`;
  return `warning: the branch is ${facts.behind} commit${facts.behind === 1 ? "" : "s"} behind \`${facts.target}\`${conflict}. Merge it in (\`git merge ${facts.target}\`) when the review allows, so CI tests what will merge`;
};

/** A CI check run on a commit, as GitHub's check-runs API lists it. */
export interface CheckRun {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  /** The run's page, when GitHub gives one. */
  readonly html_url?: string;
}

/**
 * Where CI is on a commit, judged by the latest run of each check. `before` holds the runs
 * that existed before this post: until a run not among them appears, CI hasn't answered this
 * post yet (a body edit reruns a workflow on the same commit, and its old runs are done). And
 * until each `expected` check has a run, CI is still running: Actions can create one workflow's
 * runs minutes after another's, and a green `body` alone isn't a green gate (#105's real run).
 */
export const ciState = (
  runs: ReadonlyArray<CheckRun>,
  before: ReadonlySet<number> = new Set(),
  /** Checks CI's gate makes (`gateChecks`): until each has a run, CI hasn't answered. */
  expected: ReadonlyArray<string> = [],
):
  | { readonly kind: "none" }
  | { readonly kind: "running"; readonly pending: ReadonlyArray<string> }
  | {
      readonly kind: "done";
      readonly failed: ReadonlyArray<string>;
      readonly lines: string;
      /** The latest run of each check. */
      readonly runs: ReadonlyArray<CheckRun>;
    } => {
  if (!runs.some((run) => !before.has(run.id))) return { kind: "none" };
  const of = (name: string) => (run: CheckRun) =>
    run.name === name || run.name.startsWith(`${name} (`);
  const unstarted = expected.filter((name) => !runs.some(of(name)));
  if (unstarted.length > 0)
    return { kind: "running", pending: unstarted.map((name) => `${name} (not started)`) };
  const latest = new Map<string, CheckRun>();
  for (const run of runs) if ((latest.get(run.name)?.id ?? -1) < run.id) latest.set(run.name, run);
  const current = [...latest.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pending = current.filter((run) => run.status !== "completed").map((run) => run.name);
  if (pending.length > 0) return { kind: "running", pending };
  const ok = new Set(["success", "neutral", "skipped"]);
  const failed = current
    .filter((run) => !ok.has(run.conclusion ?? ""))
    .map((run) => `${run.name} (${run.conclusion ?? "no conclusion"})`);
  const lines = current.map((run) => `  ${run.name}: ${run.conclusion}`).join("\n");
  return { kind: "done", failed, lines, runs: current };
};
