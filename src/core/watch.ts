/**
 * Watches: what `mshape msg watch` asks to be told about, and the decisions that turn what
 * `gh` and `bd` say into mail. A watch belongs to one address and lives under its mailbox;
 * `src/adapters/watch.ts` stores them, asks `gh` and `bd`, and sends what this decides as
 * ordinary mail from `WATCH_SENDER`. Each event has a key, so it is sent once per watcher,
 * across sessions and restarts.
 */
import { mshapeCommand } from "./hooks.ts";

/** The sender address of a watch's mail. It takes no mail, and no track may be named it. */
export const WATCH_SENDER = "mshape";

export type Watch =
  /**
   * `conflicting` is set while GitHub reports the PR conflicting with its base, once its
   * message is sent: absent (0.7.0's watches) is clean.
   */
  | { readonly kind: "pr"; readonly pr: string; readonly conflicting?: boolean }
  | { readonly kind: "bead"; readonly id: string }
  /** `sha` is the full commit id, resolved when the watch is made. */
  | { readonly kind: "ci"; readonly sha: string }
  /**
   * `since` is the creation time of the last head of `main` decided (at first, when the watch
   * was made): only later heads are reported. `red` is whether the last one decided failed.
   */
  | { readonly kind: "main"; readonly since: string; readonly red: boolean };

/** What a watch command names, before `gh` resolves it (a short sha to a full one). */
export type Target =
  | { readonly kind: "pr"; readonly pr: string }
  | { readonly kind: "bead"; readonly id: string }
  | { readonly kind: "ci"; readonly sha: string }
  | { readonly kind: "main" };

const PR = /^[1-9][0-9]*$/;
const SHA = /^[0-9a-f]{7,40}$/;
/** A bead id: `<prefix>-<hash>`, with `.<n>` for a child. */
const BEAD = /^[a-z0-9][a-z0-9_-]*-[a-z0-9]+(?:\.[0-9]+)*$/;

export const WATCH_USAGE = "pr <n> | bead <id> | ci <sha> | main";

/** `pr 12`, `bead x-1a`, `ci abc1234`, `main`; or why it isn't one. */
export const parseTarget = (args: ReadonlyArray<string>): Target | string => {
  const [kind, value, ...rest] = args;
  if (kind === "main" && value === undefined) return { kind: "main" };
  if (value === undefined || rest.length > 0) return `name one thing to watch: ${WATCH_USAGE}`;
  if (kind === "pr") {
    const pr = value.replace(/^#/, "");
    return PR.test(pr) ? { kind, pr } : `\`${value}\` is not a pull request number`;
  }
  if (kind === "bead")
    return BEAD.test(value) ? { kind, id: value } : `\`${value}\` is not a bead id`;
  if (kind === "ci")
    return SHA.test(value)
      ? { kind, sha: value }
      : `\`${value}\` is not a commit id: give 7 to 40 lowercase hex digits`;
  return `\`${kind}\` is not something to watch: ${WATCH_USAGE}`;
};

/** The file a watch is stored in, under its address's watches directory, without `.json`. */
export const watchKey = (watch: Target): string =>
  watch.kind === "pr"
    ? `pr-${watch.pr}`
    : watch.kind === "bead"
      ? `bead-${watch.id}`
      : watch.kind === "ci"
        ? `ci-${watch.sha}`
        : "main";

/** How a watch reads in a sentence and a command: `pr 12`, `ci abc1234`. */
export const describeWatch = (watch: Target): string =>
  watch.kind === "pr"
    ? `pr ${watch.pr}`
    : watch.kind === "bead"
      ? `bead ${watch.id}`
      : watch.kind === "ci"
        ? `ci ${watch.sha.slice(0, 7)}`
        : "main";

const record = (text: string): Record<string, unknown> | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `not JSON: ${String(error)}`;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : "not an object";
};

/** A stored watch, or why it isn't one. Strict: a key its kind doesn't have is refused. */
export const decodeWatch = (text: string): Watch | string => {
  const value = record(text);
  if (typeof value === "string") return value;
  const keys: Record<Watch["kind"], ReadonlyArray<string>> = {
    pr: ["kind", "pr"],
    bead: ["kind", "id"],
    ci: ["kind", "sha"],
    main: ["kind", "since", "red"],
  };
  const kind = value["kind"];
  if (typeof kind !== "string" || !(kind in keys)) return `unknown kind: ${String(kind)}`;
  const wanted = keys[kind as Watch["kind"]];
  // A pr watch's `conflicting` is optional: one stored before it existed has none.
  const optional = kind === "pr" ? ["conflicting"] : [];
  const extra = Object.keys(value).filter(
    (key) => !wanted.includes(key) && !optional.includes(key),
  );
  if (extra.length > 0) return `unknown keys: ${extra.join(", ")}`;
  if (value["conflicting"] !== undefined && typeof value["conflicting"] !== "boolean")
    return "missing or of the wrong type: conflicting";
  const bad = wanted.filter((key) =>
    key === "red" ? typeof value[key] !== "boolean" : typeof value[key] !== "string",
  );
  if (bad.length > 0) return `missing or of the wrong type: ${bad.join(", ")}`;
  return value as unknown as Watch;
};

export const encodeWatch = (watch: Watch): string => `${JSON.stringify(watch)}\n`;

/** What `gh api repos/{owner}/{repo}/pulls/<n>` says: one call, which gh 2.4 has. */
export interface PrSeen {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly title: string;
  readonly url: string;
  readonly mergeCommit?: string;
  /** GitHub's answer while it is open: `UNKNOWN` until it has computed it, which asking starts. */
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /**
   * The base branch. Its head is asked for apart (`git/ref/heads/<base>`): the PR's own
   * `base.sha` moves only when the PR's branch is pushed, so it trails a base that moved into
   * the conflict (#159's review).
   */
  readonly base: string;
}

export const decodePr = (text: string): PrSeen | string => {
  const value = record(text);
  if (typeof value === "string") return value;
  const { state, merged, title, html_url, merge_commit_sha, mergeable, base } = value;
  if (state !== "open" && state !== "closed") return `state is ${String(state)}`;
  if (typeof title !== "string" || typeof html_url !== "string") return "no title or html_url";
  const baseRecord =
    typeof base === "object" && base !== null ? (base as Record<string, unknown>) : {};
  const { ref } = baseRecord;
  if (typeof ref !== "string") return "no base ref";
  const isMerged = merged === true;
  return {
    state: state === "open" ? "OPEN" : isMerged ? "MERGED" : "CLOSED",
    title,
    url: html_url,
    // An open PR's merge_commit_sha is GitHub's test merge, not a merge: only a merged one's.
    ...(isMerged && typeof merge_commit_sha === "string" ? { mergeCommit: merge_commit_sha } : {}),
    mergeable: mergeable === true ? "MERGEABLE" : mergeable === false ? "CONFLICTING" : "UNKNOWN",
    base: ref,
  };
};

/** What `bd show <id> --json` says of one bead. */
export interface BeadSeen {
  readonly status: string;
  readonly title: string;
  readonly closeReason?: string;
}

export const decodeBead = (text: string): BeadSeen | string => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `not JSON: ${String(error)}`;
  }
  const first: unknown = Array.isArray(value) ? value[0] : value;
  if (typeof first !== "object" || first === null) return "no bead in it";
  const { status, title, close_reason } = first as Record<string, unknown>;
  if (typeof status !== "string" || typeof title !== "string") return "no status or title";
  return {
    status,
    title,
    ...(typeof close_reason === "string" && close_reason !== ""
      ? { closeReason: close_reason }
      : {}),
  };
};

/** One GitHub Actions run, as the runs API lists it. */
export interface Run {
  readonly sha: string;
  readonly workflow: string;
  /** `queued`, `in_progress`, `completed`, ... */
  readonly status: string;
  /** Set once completed: `success`, `failure`, `cancelled`, ... */
  readonly conclusion: string;
  readonly url: string;
  /** The head commit's first line: for a push to `main`, the merge's. */
  readonly title: string;
  readonly created: string;
}

/** `gh api repos/{owner}/{repo}/actions/runs?...`'s `workflow_runs`. */
export const decodeRuns = (text: string): ReadonlyArray<Run> | string => {
  const value = record(text);
  if (typeof value === "string") return value;
  const runs = value["workflow_runs"];
  if (!Array.isArray(runs)) return "no workflow_runs";
  const out: Array<Run> = [];
  for (const run of runs as ReadonlyArray<Record<string, unknown>>) {
    const text = (key: string): string => {
      const field = run[key];
      return typeof field === "string" ? field : "";
    };
    if (text("head_sha") === "" || text("created_at") === "") return "a run with no head or time";
    out.push({
      sha: text("head_sha"),
      workflow: text("name"),
      status: text("status"),
      conclusion: text("conclusion"),
      url: text("html_url"),
      title: text("display_title"),
      created: text("created_at"),
    });
  }
  return out;
};

/** A run that ended any way but these and `cancelled` failed: a skipped job is no failure. */
const PASSING = ["success", "skipped", "neutral"];

/**
 * A cancelled run is no verdict: CI's `cancel-in-progress` cancels a head's run when a newer
 * push supersedes it, so on `main` it mostly means a quick second merge, not a failure.
 */
const CANCELLED = "cancelled";

type Verdict =
  | { readonly ended: false }
  | {
      readonly ended: true;
      readonly failed: ReadonlyArray<Run>;
      readonly cancelled: ReadonlyArray<Run>;
      readonly runs: ReadonlyArray<Run>;
    };

/**
 * Whether every run on one head has ended, which failed and which were cancelled. No runs yet
 * is not ended.
 */
export const verdict = (runs: ReadonlyArray<Run>): Verdict =>
  runs.length === 0 || runs.some((run) => run.status !== "completed")
    ? { ended: false }
    : {
        ended: true,
        failed: runs.filter(
          (run) => !PASSING.includes(run.conclusion) && run.conclusion !== CANCELLED,
        ),
        cancelled: runs.filter((run) => run.conclusion === CANCELLED),
        runs,
      };

/** A conflict's key is this and the base's head: a key ending in `-` names every one. */
const conflictPrefix = (pr: string): string => `pr-${pr}-conflict-`;

/** Whether ledger entry `file` is one of `keys`: equal, or under a key ending in `-`. */
export const isEventOf = (file: string, keys: ReadonlyArray<string>): boolean =>
  keys.some((key) => file === key || (key.endsWith("-") && file.startsWith(key)));

/**
 * The keys of every event a watch can send, which the ledger holds once sent. A new watch
 * clears them, so "never twice" holds for one watch's life: a watch made again after it fired
 * (a re-run of CI on the same head, a PR reopened) fires again. `main` has none to clear:
 * its `since` already starts after every head it reported.
 */
export const eventKeys = (watch: Watch): ReadonlyArray<string> =>
  watch.kind === "pr"
    ? [`pr-${watch.pr}-merged`, `pr-${watch.pr}-closed`, conflictPrefix(watch.pr)]
    : watch.kind === "bead"
      ? [`bead-${watch.id}-closed`]
      : watch.kind === "ci"
        ? [`ci-${watch.sha}`]
        : [];

/** One message a watch sends: `key` is unique to the event, for this watcher. */
export interface WatchEvent {
  readonly key: string;
  readonly subject: string;
  readonly body: string;
}

/** What a check of one watch decides: the mail to send, and the watch after (or none: removed). */
export interface Decided {
  readonly events: ReadonlyArray<WatchEvent>;
  readonly next: Watch | undefined;
}

const short = (sha: string): string => sha.slice(0, 7);

/** A title from GitHub or bd, as part of a subject: one line, and short enough for every notice. */
const clip = (text: string, room: number): string => {
  const line = text.replace(/\p{Cc}+/gu, " ").trim();
  return line.length <= room ? line : `${line.slice(0, Math.max(0, room - 3))}...`;
};

/** Leaves room in a 120-character subject for what precedes the title. */
const titled = (head: string, title: string): string =>
  title === "" ? head : `${head}: ${clip(title, 118 - head.length)}`;

const removedLine = (watch: Target): string =>
  `You watched this with \`${mshapeCommand(["msg", "watch", ...describeWatch(watch).split(" ")])}\`; that watch is now removed.`;

/**
 * An open PR: one message when it starts to conflict with its base, then nothing while it
 * stays conflicting; clean again, it may send another. `UNKNOWN` decides nothing: GitHub
 * computes it after being asked, so the next check sees it.
 */
const decideOpenPr = (
  watch: Watch & { kind: "pr" },
  seen: PrSeen,
  baseHead: string | undefined,
): Decided => {
  const was = watch.conflicting ?? false;
  if (seen.mergeable === "UNKNOWN" || (seen.mergeable === "CONFLICTING") === was)
    return { events: [], next: watch };
  if (seen.mergeable === "MERGEABLE") return { events: [], next: { kind: "pr", pr: watch.pr } };
  // Its head unknown, a conflict waits for the next check rather than naming the wrong one.
  if (baseHead === undefined) return { events: [], next: watch };
  return {
    events: [
      {
        key: `${conflictPrefix(watch.pr)}${baseHead}`,
        subject: titled(`#${watch.pr} conflicts with ${seen.base}`, seen.title),
        body: [
          `GitHub reports ${seen.url} conflicting with \`${seen.base}\`, now at ${baseHead}: it can't merge until \`${seen.base}\` is merged into its branch and the conflict resolved.`,
          "",
          `The watch stays until it merges or closes, and mails again only after the PR has been clean in between.`,
        ].join("\n"),
      },
    ],
    next: { ...watch, conflicting: true },
  };
};

/**
 * Whether deciding `seen` needs its base's head: only a conflict about to be reported names
 * it, so the adapter asks for it then and no other time.
 */
export const needsBaseHead = (watch: Watch & { kind: "pr" }, seen: PrSeen): boolean =>
  seen.state === "OPEN" && seen.mergeable === "CONFLICTING" && !(watch.conflicting ?? false);

export const decidePr = (
  watch: Watch & { kind: "pr" },
  seen: PrSeen,
  /** The base branch's head now, when `needsBaseHead` says it is needed. */
  baseHead?: string,
): Decided => {
  if (seen.state === "OPEN") return decideOpenPr(watch, seen, baseHead);
  const merged = seen.state === "MERGED";
  const head = merged ? `#${watch.pr} merged` : `#${watch.pr} closed without merging`;
  return {
    events: [
      {
        key: `pr-${watch.pr}-${merged ? "merged" : "closed"}`,
        subject: titled(head, seen.title),
        body: [
          merged
            ? `${seen.url} merged${seen.mergeCommit === undefined ? "" : ` as ${seen.mergeCommit}`}.`
            : `${seen.url} was closed without merging.`,
          "",
          removedLine(watch),
        ].join("\n"),
      },
    ],
    next: undefined,
  };
};

export const decideBead = (watch: Watch & { kind: "bead" }, seen: BeadSeen): Decided =>
  seen.status !== "closed"
    ? { events: [], next: watch }
    : {
        events: [
          {
            key: `bead-${watch.id}-closed`,
            subject: titled(`${watch.id} closed`, seen.title),
            body: [`Reason: ${seen.closeReason ?? "(none given)"}`, "", removedLine(watch)].join(
              "\n",
            ),
          },
        ],
        next: undefined,
      };

const runLines = (runs: ReadonlyArray<Run>): ReadonlyArray<string> =>
  runs.map((run) => `  ${run.workflow || "(a workflow)"}: ${run.conclusion} ${run.url}`);

export const decideCi = (watch: Watch & { kind: "ci" }, runs: ReadonlyArray<Run>): Decided => {
  const ended = verdict(runs.filter((run) => run.sha === watch.sha));
  if (!ended.ended) return { events: [], next: watch };
  // A failure says more than a cancellation; a cancelled run is no pass either.
  const outcome =
    ended.failed.length > 0 ? "failed" : ended.cancelled.length > 0 ? "cancelled" : "passed";
  const named = outcome === "failed" ? ended.failed : ended.cancelled;
  const first = named[0] ?? ended.runs[0];
  return {
    events: [
      {
        key: `ci-${watch.sha}`,
        subject:
          outcome === "passed"
            ? `CI passed on ${short(watch.sha)}`
            : `CI ${outcome} on ${short(watch.sha)}: ${clip(named.map((run) => run.workflow).join(", "), 80)}`,
        body: [
          `CI on ${watch.sha} ${outcome}${first === undefined ? "" : `: ${first.url}`}`,
          ...(outcome === "cancelled"
            ? [
                "A cancelled run is usually one a newer push superseded: watch that push's head for its result.",
              ]
            : []),
          ...runLines(ended.runs),
          "",
          removedLine(watch),
        ].join("\n"),
      },
    ],
    next: undefined,
  };
};

/** The PR a push to `main` merged, from its title: `Merge pull request #N` or `Title (#N)`. */
const mergedPr = (title: string): string | undefined =>
  /^Merge pull request #([0-9]+)/.exec(title)?.[1] ?? /\(#([0-9]+)\)\s*$/.exec(title)?.[1];

/**
 * Each head of `main` newer than `since`, oldest first, until the first one still running:
 * a red head is one message, and the first green head after red is one more. The watch
 * stays, advanced to the last head decided, so no head is decided twice.
 */
export const decideMain = (watch: Watch & { kind: "main" }, runs: ReadonlyArray<Run>): Decided => {
  const heads = new Map<string, Array<Run>>();
  for (const run of runs) heads.set(run.sha, [...(heads.get(run.sha) ?? []), run]);
  const ordered = [...heads.entries()]
    .map(([sha, list]) => ({
      sha,
      list,
      created: list.map((run) => run.created).sort()[0] ?? "",
    }))
    .filter((head) => head.created > watch.since)
    .sort((a, b) => a.created.localeCompare(b.created));
  const events: Array<WatchEvent> = [];
  let { since, red } = watch;
  for (const head of ordered) {
    const ended = verdict(head.list);
    if (!ended.ended) break;
    const pr = mergedPr(head.list[0]?.title ?? "");
    const which = `${short(head.sha)}${pr === undefined ? "" : ` (#${pr})`}`;
    const failed = ended.failed.length > 0;
    // Cancelled with nothing failed: superseded by a newer merge, so no verdict. Passed over,
    // leaving red or green as the last head that had one.
    if (!failed && ended.cancelled.length > 0) {
      since = head.created;
      continue;
    }
    if (failed)
      events.push({
        key: `main-red-${head.sha}`,
        subject: `main is red at ${which}`,
        body: [
          `CI failed on main at ${head.sha}${pr === undefined ? "" : `, the merge of #${pr}`}:`,
          ...runLines(ended.failed),
          "",
          `The watch on main stays; \`${mshapeCommand(["msg", "unwatch", "main"])}\` ends it.`,
        ].join("\n"),
      });
    else if (red)
      events.push({
        key: `main-green-${head.sha}`,
        subject: `main is green again at ${which}`,
        body: [
          `CI passed on main at ${head.sha}${pr === undefined ? "" : `, the merge of #${pr}`}.`,
          "",
          `The watch on main stays; \`${mshapeCommand(["msg", "unwatch", "main"])}\` ends it.`,
        ].join("\n"),
      });
    since = head.created;
    red = failed;
  }
  return { events, next: { kind: "main", since, red } };
};

/** One line per watch, for `mshape msg watch` with no target. */
export const formatWatches = (address: string, watches: ReadonlyArray<Watch>): string =>
  watches.length === 0
    ? `No watches at ${address}. \`${mshapeCommand(["msg", "watch"])} ${WATCH_USAGE}\` adds one.`
    : [
        `Watches at ${address}; each sends mail from ${WATCH_SENDER} when it fires:`,
        ...watches.map((watch) => `  ${describeWatch(watch)}`),
      ].join("\n");
