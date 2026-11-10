/**
 * The denylist from disk and git: the lists, what a push would send, `mshape scan` and
 * `mshape review post`. Where the lists live and how they match is in `src/core/denylist.ts`.
 */
import { Effect } from "effect";
import {
  denylistPaths,
  denylistRefusal,
  findings,
  type Outgoing,
  outgoingLogArgs,
  parseDenylist,
  parseOutgoing,
} from "../core/denylist.ts";
import { PR_NUMBER } from "../core/layout.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { runTool } from "./process.ts";
import { git, locate, refuse } from "./tracks.ts";

export interface Denylist {
  readonly terms: ReadonlyArray<string>;
  /** The lists that exist; none is a note, never a failure. */
  readonly lists: ReadonlyArray<string>;
}

/** The note for a machine with no list, which `scan`, `track pr` and `review post` print. */
export const NO_DENYLIST_NOTE = (paths: ReadonlyArray<string>) =>
  `note: no denylist is configured, so nothing was scanned for private terms. Put one term per line in ${paths.join(" or ")}`;

const readText = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) => new WorkspaceError({ operation: "read", path, reason: String(cause) }),
  });

/** Both lists, read when present, from `cwd`'s clone and the machine's config directory. */
export const loadDenylist = (cwd: string, configDir: string) =>
  Effect.gen(function* () {
    const { common } = yield* locate(cwd);
    const paths = denylistPaths(configDir, common);
    const lists: Array<string> = [];
    const terms: Array<string> = [];
    for (const path of paths) {
      if (!(yield* Effect.promise(() => Bun.file(path).exists()))) continue;
      lists.push(path);
      terms.push(...parseDenylist(yield* readText(path)));
    }
    return { denylist: { terms, lists } satisfies Denylist, paths };
  });

/** The commits `tip` has that no remote ref has: what pushing it would send. */
export const outgoingCommits = (cwd: string, tip: string) =>
  Effect.flatMap(git(cwd, [...outgoingLogArgs(tip)]), (log) =>
    log.code === 0
      ? Effect.succeed(parseOutgoing(log.stdout))
      : refuse(
          `could not list the commits to scan for denylisted terms (\`git log ${tip} --not --remotes\`): ${log.stderr || `exit ${log.code}`}`,
        ),
  );

/**
 * Refuses when `outgoing` holds a listed term, `what` saying what was not done; otherwise the
 * note to print, if any.
 */
export const guard = (cwd: string, configDir: string, outgoing: Outgoing, what: string) =>
  Effect.gen(function* () {
    const { denylist, paths } = yield* loadDenylist(cwd, configDir);
    if (denylist.lists.length === 0) return NO_DENYLIST_NOTE(paths);
    const found = findings(outgoing, denylist.terms);
    if (found.length > 0)
      return yield* refuse(denylistRefusal(found, what, outgoing.commits.length > 0));
    return undefined;
  });

/** `mshape scan <file>`: the file's hits, one per line; exit 1 when there is one. */
export const scanFile = (cwd: string, configDir: string, file: string, text: string) =>
  Effect.gen(function* () {
    const { denylist, paths } = yield* loadDenylist(cwd, configDir);
    if (denylist.lists.length === 0) return { output: NO_DENYLIST_NOTE(paths), code: 0 };
    const found = findings({ commits: [], texts: [{ name: file, text }] }, denylist.terms);
    return found.length === 0
      ? { output: `${file}: no denylisted term`, code: 0 }
      : { output: found.join("\n"), code: 1 };
  });

/** Every string in a JSON value, by where it is: `body`, `comments[2].body`. */
const strings = (value: unknown, at: string): ReadonlyArray<{ name: string; text: string }> => {
  if (typeof value === "string") return [{ name: at, text: value }];
  if (Array.isArray(value)) return value.flatMap((item, i) => strings(item, `${at}[${i}]`));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      strings(item, at === "" ? key : `${at}.${key}`),
    );
  return [];
};

/**
 * `mshape review post <n> <file>`: posts the review in `file` (the JSON GitHub's reviews API
 * takes) on PR <n>, after scanning every string in it. A match refuses, posting nothing. A
 * failed post says whether GitHub has the review anyway, so nothing is posted twice.
 */
export const reviewPost = (
  cwd: string,
  configDir: string,
  pr: string,
  file: string,
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    if (!PR_NUMBER.test(pr))
      return yield* refuse(
        `give the pull request's number, e.g. \`mshape review post 12 review.json\` (got '${pr}')`,
      );
    const text = yield* readText(file);
    const parsed = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return yield* refuse(
        `${file} is not a review: give the JSON GitHub's reviews API takes, {commit_id, event, body, comments: [{path, line, side, body}]}. Nothing was posted`,
      );
    const note = yield* guard(
      cwd,
      configDir,
      { commits: [], texts: strings(parsed, "") },
      "nothing was posted",
    );
    if (note !== undefined) yield* say(note);
    const endpoint = `repos/{owner}/{repo}/pulls/${pr}/reviews`;
    const posted = yield* runTool(cwd, ["gh", "api", endpoint, "--input", file, "-q", ".html_url"]);
    if (posted.code === 0) return `posted ${posted.stdout.trim()}`;
    // gh sometimes fails after GitHub acted: say whether this review is there now.
    const body = (parsed as { body?: unknown }).body;
    const listed = yield* runTool(cwd, ["gh", "api", endpoint, "--paginate", "-q", ".[].body"]);
    const there =
      listed.code === 0 && typeof body === "string" && body.trim() !== ""
        ? listed.stdout.includes(body.trim().split("\n")[0] ?? body)
        : undefined;
    return yield* refuse(
      `posting the review on #${pr} failed: ${posted.stderr.trim() || `exit ${posted.code}`}. ${
        there === true
          ? "A review with this body's first line is on the PR now: it was posted; don't post again."
          : there === false
            ? "No review with this body's first line is on the PR yet: look again before running this again, since GitHub can be slow to list one."
            : `Look at the PR's reviews (\`gh api ${endpoint}\`) before running this again.`
      }`,
    );
  });
