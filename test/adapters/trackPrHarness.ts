/**
 * The temp repo and CLI driver the `mshape track pr` test files share: a repo with a bare
 * remote, a track `docs` with one commit, a fake gh and a stand-in for mshape's gate. `base`,
 * `repo`, `bin` and `gh` are live bindings; each test starts from the saved build.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { prSkeleton } from "../../src/core/conventions.ts";
import { useSavedDir } from "./savedDir.ts";

export const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
export let base = "";
export let repo = "";
export let bin = "";
export let gh = "";

export const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

export const wt = () => `${repo}/.agents/worktrees/repo@docs`;

/** `mshape track ...`, with the fake gh first on PATH and no bd; `extra` adds to its env. */
const run = (extra: Record<string, string>, cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync([process.execPath, CLI, "track", ...args], {
    cwd,
    env: {
      ...process.env,
      ...extra,
      PATH: `${bin}:/usr/bin:/bin`,
      FAKE_GH: gh,
      CLAUDE_CONFIG_DIR: join(base, "no-claude"),
      // Never this machine's own denylist, nor its Claude sessions.
      XDG_CONFIG_HOME: join(base, "config"),
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: result.stdout.toString().trim(),
    stderr: result.stderr.toString().trim(),
  };
};
export const mshape = Object.assign(
  (cwd: string, ...args: ReadonlyArray<string>) => run({}, cwd, ...args),
  {
    withEnv:
      (extra: Record<string, string>) =>
      (cwd: string, ...args: ReadonlyArray<string>) =>
        run(extra, cwd, ...args),
  },
);

/**
 * A fake `gh`: `pr list` prints the PR in $FAKE_GH/pr.json, if any; `pr create` and `pr edit`
 * store the body file there; every call is appended to calls.log. `fail` makes create fail.
 */
export const FAKE_GH = `
const [, , ...args] = process.argv;
const dir = process.env.FAKE_GH;
const state = Bun.file(dir + "/pr.json");
await Bun.write(dir + "/calls.log", ((await Bun.file(dir + "/calls.log").exists()) ? await Bun.file(dir + "/calls.log").text() : "") + args.join(" ") + "\\n");
const flag = (name) => args[args.indexOf(name) + 1];
if (args[1] === "list") {
  // As gh 2.4: a JSON field it doesn't know fails the call.
  if (flag("--json").split(",").some((field) => !["number", "url", "body", "title"].includes(field))) {
    console.error("Unknown JSON field: " + flag("--json"));
    process.exit(1);
  }
  console.log((await state.exists()) ? "[" + (await state.text()) + "]" : "[]");
} else if (args[0] === "api" && (args[1] ?? "").split("/").at(-2) === "pulls" && !args.includes("--method")) {
  // The PR's head is what the remote's branch is at, as GitHub reports it.
  const head = Bun.spawnSync(["git", "rev-parse", "refs/heads/track/docs"], { cwd: dir + "/../remote.git" });
  console.log(head.stdout.toString().trim());
} else if (args[0] === "api" && (args[1] ?? "").endsWith("/reviews")) {
  // The reviews, as each query track pr has sent prints them; any other query fails, so a
  // test can't pass on a query the fake doesn't model.
  const file = Bun.file(dir + "/reviews.json");
  const reviews = (await file.exists()) ? JSON.parse(await file.text()) : [];
  const query = flag("-q");
  if (query === ".[] | {commit_id, body} | @json")
    for (const review of reviews) console.log(JSON.stringify({ commit_id: review.commit_id, body: review.body }));
  else if (query === ".[].commit_id") for (const review of reviews) console.log(review.commit_id);
  else {
    console.error("fake gh: unmodelled query " + query);
    process.exit(1);
  }
}
else if (args[0] === "api" && (args[1] ?? "").endsWith("/check-runs")) {
  // CI's check runs: checks.json, or the next of checks-<n>.json on each call.
  if (flag("-q") !== ".check_runs[] | {id, name, status, conclusion, html_url} | @json") { console.error("fake gh: unmodelled query"); process.exit(1); }
  const count = Bun.file(dir + "/polls");
  const n = (await count.exists()) ? Number(await count.text()) : 0;
  await Bun.write(count, String(n + 1));
  const staged = Bun.file(dir + "/checks-" + n + ".json");
  const file = (await staged.exists()) ? staged : Bun.file(dir + "/checks.json");
  if (await file.exists()) for (const run of JSON.parse(await file.text())) console.log(JSON.stringify(run));
}
else if (args[1] === "create") {
  if (await Bun.file(dir + "/fail").exists()) { console.error("HTTP 502"); process.exit(1); }
  const pr = { number: 7, url: "https://example.test/pr/7", title: flag("--title"), body: await Bun.file(flag("--body-file")).text() };
  await Bun.write(state, JSON.stringify(pr));
  console.log(pr.url);
} else if (args[0] === "api" && flag("--method") === "PATCH") {
  // REST: \`-F body=@<file>\` reads the file; \`-f title=<t>\` is a raw string.
  const pr = JSON.parse(await state.text());
  for (const [i, arg] of args.entries()) {
    const value = args[i + 1] ?? "";
    if (arg === "-F" && value.startsWith("body=@")) pr.body = await Bun.file(value.slice(6)).text();
    if (arg === "-f" && value.startsWith("title=")) pr.title = value.slice(6);
  }
  await Bun.write(state, JSON.stringify(pr));
} else {
  // gh pr edit, as old gh versions fail it, and anything unexpected.
  console.error("GraphQL: Projects (classic) is being deprecated");
  process.exit(1);
}
`;

export const body = (narrative: string) =>
  prSkeleton({
    "What changed and why": narrative,
    Evidence: "Ran it.",
    "Not done": "Nothing.",
    Beads: "- x-abc.1 the bead",
  });

export const pr = async () => JSON.parse(await Bun.file(`${gh}/pr.json`).text());

/** The repo every track pr test starts from: a track `docs` with one commit, a bare remote. */
export const useTrackPrRepo = () =>
  useSavedDir(
    "mshape-trackpr-",
    (dir) => {
      base = dir;
      repo = join(base, "repo");
      bin = join(base, "bin");
      gh = join(base, "gh");
    },
    async () => {
      await mkdir(repo);
      await mkdir(bin);
      await mkdir(gh);
      await writeFile(join(base, "gh.js"), FAKE_GH);
      await writeFile(
        join(bin, "gh"),
        `#!/bin/sh\nexec "${process.execPath}" "${base}/gh.js" "$@"\n`,
      );
      await chmod(join(bin, "gh"), 0o755);
      sh(base, "init", "-q", "--bare", "-b", "main", "remote.git");
      sh(repo, "init", "-q", "-b", "main");
      sh(repo, "config", "user.name", "Test");
      sh(repo, "config", "user.email", "test@example.com");
      sh(repo, "config", "commit.gpgsign", "false");
      // A stand-in for mshape, reached as track pr reaches it (the `mshape` script): its gate
      // passes unless the file `red` exists, prints a summary to stderr, and runs the red test
      // file only in the whole gate, never with --fast.
      await writeFile(
        join(repo, "package.json"),
        JSON.stringify({ scripts: { mshape: "sh fake-mshape.sh" } }),
      );
      await writeFile(join(repo, "fake-mshape.sh"), FAKE_MSHAPE);
      await writeFile(join(repo, "shape.toml"), 'packs = ["typescript"]\n');
      await writeFile(join(repo, ".gitignore"), ".agents/worktrees/\n.handoffs\nbody.md\nlate\n");
      sh(repo, "add", ".");
      sh(repo, "commit", "-qm", "init");
      sh(repo, "remote", "add", "origin", join(base, "remote.git"));
      sh(repo, "push", "-q", "-u", "origin", "main");
      mshape(repo, "new", "docs");
      await writeFile(`${wt()}/page.md`, "page\n");
      sh(wt(), "add", ".");
      sh(wt(), "commit", "-qm", "page");
    },
  );

export const FAKE_MSHAPE = `echo "gate ran: $*"
echo ' 3 pass' >&2
test ! -e red || { echo '(fail) suite > the red test [0.50ms]'; exit 1; }
test -z "$NEED" || test -e "$NEED" || exit 1
test -z "$LATE" || git -C "$LATE" commit -q --allow-empty -m late-unreviewed
test "$2" = "--fast" || test ! -e always.test.ts || { echo '(fail) always > red'; exit 1; }
`;

export const remoteHas = () =>
  Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", "refs/heads/track/docs"], {
    cwd: join(base, "remote.git"),
  }).exitCode === 0;
