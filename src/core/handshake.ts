/**
 * The review handshake's messages: what `mshape review post` mails the track a review is of,
 * and what `mshape track pr` mails that track's reviewer after a push. Each names what the
 * other must act on and where it is, never the whole review: the PR holds that. The I/O is
 * in `src/cli/main.ts` (`review post`) and `src/adapters/trackPr.ts`.
 */
import type { CheckRun } from "./trackPr.ts";

/** A review as `mshape review post` takes it: the JSON GitHub's reviews API takes. */
export interface ReviewInput {
  readonly body?: unknown;
  readonly comments?: unknown;
}

export interface Finding {
  /** `blocker`, `nit`, or `finding` when the comment names neither. */
  readonly severity: string;
  /** Where it is anchored: `path:line`. */
  readonly at: string;
  /** Its bold opening sentence, or its first line. */
  readonly summary: string;
}

/** A comment's opening: `**Blocker: what is wrong.**`, `**Nit**: ...`, or plain text. */
const finding = (comment: unknown): Finding | undefined => {
  if (typeof comment !== "object" || comment === null) return undefined;
  const { body, path, line } = comment as { body?: unknown; path?: unknown; line?: unknown };
  if (typeof body !== "string") return undefined;
  // Bold and emphasis are markup: `**Blocker: x.**`, `**Blocker**: x`, `Nit: x` read alike.
  const first = (body.trim().split("\n")[0] ?? "").replace(/\*\*|__/g, "").trim();
  const labelled = /^(blocker|nit)\b\s*(?:\([^)]*\))?\s*[:.\u2014-]?\s*(.*)$/i.exec(first);
  const severity = labelled?.[1]?.toLowerCase() ?? "finding";
  const summary = (labelled?.[2] || first).trim();
  return {
    severity,
    at: `${typeof path === "string" ? path : "?"}:${typeof line === "number" ? line : "?"}`,
    summary: summary.length > 160 ? `${summary.slice(0, 157)}...` : summary,
  };
};

/** The review's inline findings, in the order it gives them. */
export const findings = (review: ReviewInput): ReadonlyArray<Finding> =>
  Array.isArray(review.comments)
    ? review.comments.flatMap((comment) => finding(comment) ?? [])
    : [];

/**
 * Whether the review says LGTM: the word in its body, and no blocker among its comments. A
 * review that says "no LGTM yet" beside a blocker is not one.
 */
export const isLgtm = (review: ReviewInput): boolean =>
  typeof review.body === "string" &&
  /\bLGTM\b/.test(review.body) &&
  !findings(review).some((item) => item.severity === "blocker");

const count = (n: number, what: string) => `${n} ${what}${n === 1 ? "" : "s"}`;

/** What the track gets once its PR's review is posted. */
export const reviewMessage = (
  pr: string,
  url: string,
  review: ReviewInput,
  /** Where the reviewer takes mail: the author tells it there once the PR is updated. */
  reviewer: string,
): { readonly subject: string; readonly body: string } => {
  if (isLgtm(review))
    return {
      subject: `#${pr}: LGTM`,
      body: `Review: ${url}\nLGTM: nothing open. Merging is the maintainer's.`,
    };
  const found = findings(review);
  const blockers = found.filter((item) => item.severity === "blocker").length;
  const nits = found.filter((item) => item.severity === "nit").length;
  const other = found.length - blockers - nits;
  const tally = [
    ...(blockers > 0 ? [count(blockers, "blocker")] : []),
    ...(nits > 0 ? [count(nits, "nit")] : []),
    ...(other > 0 ? [count(other, "finding")] : []),
  ];
  return {
    subject: `#${pr} reviewed: ${tally.length === 0 ? "no inline findings" : tally.join(", ")}`,
    body: [
      `Review: ${url}`,
      ...found.map((item) => `- ${item.severity} (${item.at}): ${item.summary}`),
      ...(found.length === 0 ? ["No inline findings: the review's body says what it found."] : []),
      `Answer on the PR; track pr mails ${reviewer} each push from now on.`,
    ].join("\n"),
  };
};

/** What the reviewer gets after a push answering its review: the head, and CI on it if known. */
export const pushMessage = (
  pr: number,
  url: string,
  head: string,
  /** CI's runs on the head, once `--wait` has them; none when it wasn't waited for. */
  runs?: ReadonlyArray<CheckRun>,
): { readonly subject: string; readonly body: string } => {
  const short = head.slice(0, 12);
  if (runs === undefined)
    return {
      subject: `#${pr} pushed ${short}: CI not waited for`,
      body: `${url} is at ${short}. track pr didn't wait for CI (no --wait): check it before re-reviewing.`,
    };
  const ok = new Set(["success", "neutral", "skipped"]);
  const failed = runs.filter((run) => !ok.has(run.conclusion ?? ""));
  return {
    subject: `#${pr} pushed ${short}: CI ${failed.length === 0 ? "passed" : "failed"}`,
    body: [
      `${url} is at ${short}.`,
      ...runs.map(
        (run) =>
          `- ${run.name}: ${run.conclusion ?? run.status}${run.html_url === undefined ? "" : ` ${run.html_url}`}`,
      ),
    ].join("\n"),
  };
};
