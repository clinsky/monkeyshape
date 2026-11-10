/**
 * `mshape track pr`: run the gate fresh, push `track/<name>`, and open or update its PR. The
 * Gate section is the only one it writes, from the run it just did; the rest of the body is
 * the agent's (`--body-file`, or the PR as it stands). Nothing is pushed or posted unless the
 * worktree is clean, nothing it would send holds a denylisted term, the gate passes and the
 * body has every required section, so a failure leaves the PR as it was. The decisions are in `src/core/trackPr.ts`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { GATE_COMMAND, GATE_SCRIPT, prSizeNote } from "../core/conventions.ts";
import { MAIN_BRANCH, trackBranch } from "../core/layout.ts";
import { changedLines, gateSection, gateTail, planPrBody } from "../core/trackPr.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { guard, outgoingCommits } from "./denylist.ts";
import { fetchUpstream, git, gitOk, locate, mergeTargets, refuse, trackCurrent } from "./tracks.ts";

/** A command's exit and output; `missing` when it isn't on PATH. */
const spawn = (
  cwd: string,
  command: ReadonlyArray<string>,
  env?: Record<string, string | undefined>,
) =>
  Effect.try({
    try: () => {
      const child = Bun.spawnSync([...command], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        ...(env === undefined ? {} : { env }),
      });
      return {
        missing: false,
        code: child.exitCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString().trim(),
      };
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      /ENOENT|not found in \$PATH/.test(String(cause))
        ? Effect.succeed({ missing: true, code: -1, stdout: "", stderr: "" })
        : Effect.fail(
            new WorkspaceError({
              operation: "run",
              path: command.join(" "),
              reason: String(cause),
            }),
          ),
    ),
  );

interface OpenPr {
  readonly number: number;
  readonly url: string;
  readonly body: string;
}

/** The open PR from `branch`, if any; a `gh` that can't answer refuses, saying why. */
const openPr = (cwd: string, branch: string) =>
  Effect.gen(function* () {
    const listed = yield* spawn(cwd, [
      "gh",
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "number,url,body",
    ]);
    if (listed.missing)
      return yield* refuse(
        "`gh` is not on PATH, so no PR can be opened: install the GitHub CLI and run `gh auth login`",
      );
    if (listed.code !== 0)
      return yield* refuse(`\`gh pr list\` failed: ${listed.stderr || `exit ${listed.code}`}`);
    const prs = JSON.parse(listed.stdout || "[]") as ReadonlyArray<OpenPr>;
    return prs[0];
  });

export const trackPr = (
  cwd: string,
  options: {
    readonly title: string | undefined;
    /** The agent's whole body: the narrative and evidence, which this keeps as written. */
    readonly body: string | undefined;
    /** The environment for git's network calls: one where it can't prompt. */
    readonly fetchEnv: Readonly<Record<string, string | undefined>>;
    /** The machine's config directory, which holds its denylist. */
    readonly configDir: string;
  },
  say: (line: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const track = yield* trackCurrent(cwd);
    const branch = trackBranch(track);
    const { repo } = yield* locate(cwd);
    const top = yield* gitOk(cwd, ["rev-parse", "--show-toplevel"]);
    const dirty = (yield* gitOk(top, ["status", "--porcelain"]))
      .split("\n")
      .filter((l) => l !== "");
    if (dirty.length > 0)
      return yield* refuse(
        `the worktree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}), and the gate must run on exactly what is pushed: commit or discard them, then run track pr again`,
      );

    // Before the slow gate, so a missing title or gh is said at once.
    const existing = yield* openPr(top, branch);
    if (existing === undefined && (options.title === undefined || options.body === undefined))
      return yield* refuse(
        `no PR is open from \`${branch}\`: opening one needs --title "<title>" and --body-file <path>, a body with every section of .github/pull_request_template.md; track pr fills the Gate section itself`,
      );

    const unfetched = yield* fetchUpstream(repo, options.fetchEnv);
    if (unfetched !== undefined) yield* say(`note: ${unfetched}`);
    const targets = yield* mergeTargets(repo);
    const base = yield* gitOk(top, [
      "merge-base",
      "HEAD",
      targets[targets.length - 1] ?? MAIN_BRANCH,
    ]);
    const lines = changedLines(yield* gitOk(top, ["diff", "--shortstat", base, "HEAD"]));
    yield* say(prSizeNote(lines));

    const commit = yield* gitOk(top, ["rev-parse", "HEAD"]);
    // Before the slow gate, and after the fetch, so the remote refs say what is published.
    const remote =
      (yield* git(repo, ["config", `branch.${MAIN_BRANCH}.remote`])).stdout.trim() || "origin";
    const unpublished = yield* outgoingCommits(top, commit, remote);
    const notConfigured = yield* guard(
      top,
      options.configDir,
      {
        commits: unpublished,
        texts: [
          ...(options.title === undefined ? [] : [{ name: "the PR title", text: options.title }]),
          { name: "the PR body", text: options.body ?? existing?.body ?? "" },
        ],
      },
      "nothing was pushed or posted",
    );
    if (notConfigured !== undefined) yield* say(notConfigured);
    yield* say(
      `running the gate, \`${GATE_COMMAND}\`, on ${commit.slice(0, 12)}: it can take minutes`,
    );
    // One stream, as a terminal shows it: the summary lines come from both.
    const gate = yield* spawn(top, ["sh", "-c", `"$0" run ${GATE_SCRIPT} 2>&1`, process.execPath]);
    const tail = gateTail(gate.stdout);
    if (gate.code !== 0)
      return yield* refuse(
        `the gate failed (exit ${gate.code}), so nothing was pushed or posted. Its last lines:\n${tail}`,
      );

    const plan = planPrBody(
      options.body ?? existing?.body ?? "",
      gateSection(GATE_COMMAND, commit, gate.stdout),
    );
    if ("problems" in plan)
      return yield* refuse(
        ["the body isn't ready, so nothing was pushed or posted:", ...plan.problems].join("\n  "),
      );
    // The Gate section is new text too: the gate's output could print anything.
    yield* guard(
      top,
      options.configDir,
      { commits: [], texts: [{ name: "the PR body", text: plan.body }] },
      "nothing was pushed or posted",
    );
    const unknown: Array<string> = [];
    for (const id of plan.beads) {
      const shown = yield* spawn(repo, ["bd", "show", id, "--json"]);
      if (shown.missing) {
        yield* say("note: `bd` is not on PATH, so the listed beads weren't checked");
        break;
      }
      if (shown.code !== 0) unknown.push(id);
    }
    if (unknown.length > 0)
      return yield* refuse(
        `the Beads section lists ${unknown.map((id) => `\`${id}\``).join(", ")}, which bd doesn't know: fix the id, or file the bead first. Nothing was pushed or posted`,
      );

    // The commit the gate ran on, not the branch: one made while the gate ran is ungated.
    const pushed = yield* git(top, ["push", "--quiet", remote, `${commit}:refs/heads/${branch}`], {
      env: { ...options.fetchEnv },
    });
    if (pushed.code !== 0)
      return yield* refuse(
        `\`git push ${remote} ${branch}\` failed, so the PR wasn't touched: ${pushed.stderr || `exit ${pushed.code}`}${
          /non-fast-forward|fetch first|\[rejected\]/.test(pushed.stderr)
            ? `. \`${remote}\`'s \`${branch}\` has commits this branch lacks: if they are an earlier track's of this name (squash-merged, or dropped), delete it (\`git push ${remote} --delete ${branch}\`); if they are this track's, merge them in (\`git pull ${remote} ${branch}\`)`
            : ""
        }`,
      );

    const now = yield* gitOk(top, ["rev-parse", "HEAD"]);
    if (now !== commit)
      yield* say(
        `note: \`${branch}\` moved to ${now.slice(0, 12)} while the gate ran; pushed ${commit.slice(0, 12)}, the commit it gated. Run track pr again to gate and push the rest`,
      );

    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-pr-")));
    const file = join(dir, "body.md");
    yield* Effect.promise(() => writeFile(file, plan.body));
    // An update goes through REST: `gh pr edit` fails on some gh versions, since GitHub
    // retired the Projects (classic) field it asks for.
    const posted = existing
      ? yield* spawn(top, [
          "gh",
          "api",
          "--method",
          "PATCH",
          `repos/{owner}/{repo}/pulls/${existing.number}`,
          "-F",
          `body=@${file}`,
          ...(options.title === undefined ? [] : ["-f", `title=${options.title}`]),
        ])
      : yield* spawn(top, [
          "gh",
          "pr",
          "create",
          "--base",
          MAIN_BRANCH,
          "--head",
          branch,
          "--title",
          options.title ?? "",
          "--body-file",
          file,
        ]);
    yield* Effect.promise(() => rm(dir, { recursive: true, force: true }));
    if (posted.code !== 0) {
      // gh sometimes fails after GitHub acted: say what is there now, so nothing is posted twice.
      const now = yield* openPr(top, branch).pipe(Effect.orElseSucceed(() => undefined));
      return yield* refuse(
        `${existing ? `updating PR #${existing.number}` : "`gh pr create`"} failed: ${posted.stderr || `exit ${posted.code}`}. ${
          now === undefined
            ? "No PR is open from the branch."
            : `A PR is open now (${now.url}): look at it before running track pr again.`
        }`,
      );
    }
    const url = existing?.url ?? posted.stdout.trim().split("\n").at(-1) ?? "";
    return [
      existing
        ? `updated ${url}: the Gate section is from this run; every other section is ${options.body === undefined ? "as it was" : "from --body-file"}`
        : `opened ${url}`,
    ].join("\n");
  });
