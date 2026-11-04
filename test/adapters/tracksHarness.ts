/**
 * The temp repo and CLI driver every `mshape track` test file shares: real git, real
 * worktrees, a fake gh and a scratch Claude Code config directory. Never the real repo's
 * worktrees. `base` and `repo` are live bindings, reassigned for each test.
 */
import { afterEach, beforeEach } from "bun:test";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");
export let base = "";
export let repo = "";

/** For a test that moves the repo: where it is now. */
export const movedTo = (path: string) => {
  repo = path;
};

export const sh = (cwd: string, ...args: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
};

export const mshapeWith = (
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  ...args: ReadonlyArray<string>
) => {
  const result = Bun.spawnSync([process.execPath, CLI, "track", ...args], {
    cwd,
    // rm reads Claude Code's sessions: a scratch directory, never the real ~/.claude.
    // A fake gh (`fakeGh`), never the real one: list reads PRs from GitHub.
    env: {
      ...process.env,
      PATH: `${base}/fake-gh:${process.env["PATH"] ?? ""}`,
      CLAUDE_CONFIG_DIR: join(base, "no-claude"),
      ...env,
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

export const mshape = (cwd: string, ...args: ReadonlyArray<string>) => mshapeWith({}, cwd, ...args);

export const exists = (path: string) =>
  lstat(path).then(
    () => true,
    () => false,
  );

export const branches = () => sh(repo, "branch", "--format=%(refname:lstrip=2)").split("\n").sort();
export const wt = (track: string) => `${repo}/.agents/worktrees/repo@${track}`;
export const handoff = (track: string) => `${repo}/.git/monkeyshape/handoffs/${track}.md`;

export const setup = async (sharedPaths: ReadonlyArray<string> = []) => {
  await writeFile(
    join(repo, "shape.config.ts"),
    `export default ${JSON.stringify({ tracks: { sharedPaths } })};\n`,
  );
  await writeFile(
    join(repo, ".gitignore"),
    ".agents/worktrees/\n.agents/handoffs\n.handoffs\ndata\n",
  );
  sh(repo, "add", ".");
  sh(repo, "commit", "-qm", "init");
};

const fresh = async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "mshape-tracks-")));
  repo = join(base, "repo");
  await mkdir(repo);
  sh(repo, "init", "-q", "-b", "main");
  sh(repo, "config", "user.name", "Test");
  sh(repo, "config", "user.email", "test@example.com");
  sh(repo, "config", "commit.gpgsign", "false");
  await fakeGh([]);
};

/** `gh pr list` prints these PRs (JSON); `fakeGh(undefined)` makes gh fail like a repo with no remote. */
export const fakeGh = async (prs: ReadonlyArray<object> | undefined) => {
  await mkdir(`${base}/fake-gh`, { recursive: true });
  await writeFile(
    `${base}/fake-gh/gh`,
    prs === undefined
      ? "#!/bin/sh\necho 'no git remotes found' >&2\nexit 1\n"
      : `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify(prs)}\nEOF\n`,
  );
  await chmod(`${base}/fake-gh/gh`, 0o755);
};

/** A fresh temp repo per test, removed after it: call once at the top of each test file. */
export const useTrackRepo = () => {
  beforeEach(fresh);
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });
};
