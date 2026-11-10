/**
 * The denylist: terms that must never leave the machine (private project names, people,
 * domains), checked before `track pr` pushes and before `review post` posts. The list is
 * never in a repo, since the terms that matter are exactly the ones a public repo must not
 * contain. It lives in two places, both read when present:
 *
 *   <config dir>/monkeyshape/denylist        per machine (`$XDG_CONFIG_HOME`, else `~/.config`)
 *   <git common dir>/monkeyshape/denylist    per clone, inside `.git`, so never committed
 *
 * One term per line; blank lines and lines starting with `#` are ignored. A term matches
 * case-insensitively, as a substring. Only what is about to leave is scanned (`track pr`: the
 * commits no remote ref has, their added lines, added paths and messages, and the PR's title
 * and body), so a newly listed term never fails content already published.
 */

/** Where the lists are, from the config directory and git's common directory. */
export const denylistPaths = (configDir: string, common: string): ReadonlyArray<string> => [
  `${configDir}/monkeyshape/denylist`,
  `${common}/monkeyshape/denylist`,
];

/** The terms in one list's text: trimmed, without blank lines or `#` comments. */
export const parseDenylist = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

export interface Hit {
  /** 1-based, in the scanned text. */
  readonly line: number;
  /** 1-based, in UTF-16 code units, as an editor counts on a BMP line. */
  readonly column: number;
  readonly term: string;
}

/** Every place a term occurs in `text`, by line, then column. */
export const scanText = (text: string, terms: ReadonlyArray<string>): ReadonlyArray<Hit> => {
  // A regex, not lowercased copies: lowercasing can change a string's length, and the columns.
  const needles = terms.map((term) => ({
    term,
    pattern: new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
  }));
  return text.split(/\r?\n/).flatMap((line, index) =>
    needles
      .flatMap(({ term, pattern }) => {
        const hits: Array<Hit> = [];
        pattern.lastIndex = 0;
        for (let match = pattern.exec(line); match !== null; match = pattern.exec(line)) {
          hits.push({ line: index + 1, column: match.index + 1, term });
          pattern.lastIndex = match.index + 1;
        }
        return hits;
      })
      .sort((a, b) => a.column - b.column),
  );
};

/** One commit about to leave: its message, the lines it adds and the paths it adds. */
export interface OutgoingCommit {
  readonly sha: string;
  readonly message: string;
  readonly added: ReadonlyArray<{
    readonly path: string;
    readonly line: number;
    readonly text: string;
  }>;
  readonly paths: ReadonlyArray<string>;
}

/**
 * The commits pushing `tip` to `remote` would send: those `remote`'s refs don't have. A commit
 * only another remote has is still sent, so still scanned.
 */
export const outgoingRevListArgs = (tip: string, remote: string): ReadonlyArray<string> => [
  "rev-list",
  tip,
  "--not",
  `--remotes=${remote}`,
];

/** A commit's message, as `git show` prints it with these arguments. */
export const messageArgs = (sha: string): ReadonlyArray<string> => [
  "show",
  "--no-patch",
  "--format=%B",
  sha,
];

/**
 * A commit's patch with no context, for `parsePatch`. One commit per call, so nothing in a
 * file can be read as the start of another commit. `--cc` shows a merge's own changes only,
 * never the lines it brings from either parent, so merging `main` adds nothing to scan.
 * `--text` shows a file git would call binary (a NUL byte is enough) as lines too.
 */
export const patchArgs = (sha: string): ReadonlyArray<string> => [
  "-c",
  "core.quotePath=false",
  "show",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--text",
  "--cc",
  "--unified=0",
  "--format=",
  sha,
];

const ESCAPES: Readonly<Record<string, number>> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/**
 * A path as git writes it: bare, or C-quoted (`"a\"b"`, octal bytes for the rest) when it
 * holds a quote, a backslash or a control character. The path, and the text after it.
 */
export const gitPath = (text: string): { path: string; rest: string } => {
  if (!text.startsWith('"')) return { path: text, rest: "" };
  const bytes: Array<number> = [];
  let i = 1;
  while (i < text.length && text[i] !== '"') {
    const char = text[i] ?? "";
    if (char !== "\\") {
      bytes.push(...new TextEncoder().encode(char));
      i += 1;
      continue;
    }
    const octal = /^[0-7]{3}/.exec(text.slice(i + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      i += 4;
    } else {
      bytes.push(ESCAPES[text[i + 1] ?? ""] ?? text.charCodeAt(i + 1));
      i += 2;
    }
  }
  return { path: new TextDecoder().decode(new Uint8Array(bytes)), rest: text.slice(i + 1) };
};

/**
 * The path a `diff --git a/<p> b/<p>` header names, bare or quoted. When the halves differ
 * (a rename, named again by `rename to`), the whole header: scanned as a path, a term in it
 * is still found, so an unreadable header never hides one.
 */
const headerPath = (header: string): string => {
  const cc = /^diff --(?:cc|combined) (.*)$/.exec(header);
  if (cc?.[1] !== undefined) return gitPath(cc[1]).path;
  const rest = header.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const first = gitPath(rest);
    const second = gitPath(first.rest.trimStart());
    if (first.path.startsWith("a/") && second.path === `b/${first.path.slice(2)}`)
      return second.path.slice(2);
    return rest;
  }
  const bare = rest.slice(2);
  const half = (bare.length - 3) / 2;
  return Number.isInteger(half) && bare.slice(half, half + 3) === " b/"
    ? bare.slice(0, half)
    : rest;
};

/** One commit's patch: the lines it adds, where, and the paths it adds or renames to. */
export const parsePatch = (patch: string): Pick<OutgoingCommit, "added" | "paths"> => {
  const added: Array<OutgoingCommit["added"][number]> = [];
  const paths: Array<string> = [];
  let path: string | undefined;
  let next = 0;
  let parents = 1;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --")) {
      path = headerPath(line);
      parents = line.startsWith("diff --git") ? 1 : 2;
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      const plus = /^\+\+\+ (.*)$/.exec(line);
      if (plus?.[1] !== undefined) {
        const named = gitPath(plus[1]).path;
        path = named.startsWith("b/") ? named.slice(2) : undefined;
      }
      const renamed = /^(?:rename|copy) to (.*)$/.exec(line);
      if (renamed?.[1] !== undefined) {
        path = gitPath(renamed[1]).path;
        paths.push(path);
      }
      if (line.startsWith("new file mode") && path !== undefined) paths.push(path);
    }
    const hunk = /^@@+ (?:-\S+ )+\+(\d+)(?:,\d+)? @@+/.exec(line);
    if (hunk?.[1] !== undefined) {
      next = Number(hunk[1]);
      parents = (/^@+/.exec(line)?.[0].length ?? 2) - 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    const marks = line.slice(0, parents);
    if (marks.length < parents || /[^ +-]/.test(marks)) continue;
    if (marks.includes("-")) continue;
    // Added against every parent: this commit's own line, not one brought from a parent.
    if (/^\++$/.test(marks))
      added.push({
        path: path ?? "(a file with no name in the patch)",
        line: next,
        text: line.slice(parents),
      });
    next += 1;
  }
  return { added, paths };
};

/** What a push or a post would send, for `findings`: each part is scanned on its own. */
export interface Outgoing {
  readonly commits: ReadonlyArray<OutgoingCommit>;
  /** Free text such as a PR title or body, by the name a finding gives it. */
  readonly texts: ReadonlyArray<{ readonly name: string; readonly text: string }>;
}

/** A term found where it would leave the machine, as one line naming where. */
export const findings = (
  outgoing: Outgoing,
  terms: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  if (terms.length === 0) return [];
  const at = (hit: Hit) => `line ${hit.line}, column ${hit.column}: "${hit.term}"`;
  return [
    ...outgoing.texts.flatMap(({ name, text }) =>
      scanText(text, terms).map((hit) => `${name}, ${at(hit)}`),
    ),
    ...outgoing.commits.flatMap((commit) => {
      const short = commit.sha.slice(0, 12);
      return [
        ...scanText(commit.message, terms).map(
          (hit) => `the message of commit ${short}, ${at(hit)}`,
        ),
        ...commit.paths.flatMap((path) =>
          scanText(path, terms).map(
            (hit) =>
              `the path ${path}, added by commit ${short}, column ${hit.column}: "${hit.term}"`,
          ),
        ),
        ...commit.added.flatMap(({ path, line, text }) =>
          scanText(text, terms).map(
            (hit) => `${path}:${line}:${hit.column}, added by commit ${short}: "${hit.term}"`,
          ),
        ),
      ];
    }),
  ];
};

/** How many places a refusal lists: the rest are counted, since one rewrite fixes most. */
export const REFUSAL_PLACES = 20;

/**
 * The refusal for `findings`, saying what to do; `what` is what was not done. The advice on
 * rewriting a commit only when commits were scanned: a review has none.
 */
export const denylistRefusal = (
  found: ReadonlyArray<string>,
  what: string,
  commits = true,
): string =>
  [
    `a denylisted term would leave the machine, so ${what}. Remove or reword each, then run this again:`,
    ...found.slice(0, REFUSAL_PLACES).map((line) => `  ${line}`),
    ...(found.length > REFUSAL_PLACES ? [`  and ${found.length - REFUSAL_PLACES} more`] : []),
    ...(commits
      ? [
          "A term in a commit's message, lines or paths is fixed only by rewriting that commit before it is pushed: `git commit --amend` for the last one; for an earlier one, `git reset --soft <its parent>` and commit again.",
        ]
      : []),
  ].join("\n");
