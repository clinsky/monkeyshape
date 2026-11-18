/**
 * How hooks and skills run `mshape` (D-run-mshape), tried where they run it: the `mshape`
 * installed once per machine in `~/.local/bin`, run from a repo born with `mshape init`, from a
 * subdirectory, and from a track worktree with no `node_modules`. The shell gets the PATH a
 * hook may get: system tools only, no Bun and no `mshape`, so the hook finds it in
 * `~/.local/bin`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { compileBinaries, packSource } from "../../src/adapters/release.ts";
import { HOOKS, mshapeCommand, withMshape } from "../../src/core/hooks.ts";
import { INSTALL_URL } from "../../src/core/launch.ts";
import { BINARY_TARGETS, packVersion } from "../../src/core/release.ts";
import { initFromSource, pack, ROOT, run, unexpectedNotes } from "./harness.ts";

const host = BINARY_TARGETS.find(
  (target) => target.platform === `${process.platform}-${process.arch}`,
);

let work = "";
let repo = "";
let born = { code: 0, output: "" };
const home = () => join(work, "home");
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const worktree = () => join(repo, ".agents", "worktrees", "demo@a");

/** A hook's environment: no Bun and no `mshape` on the PATH, this test's home. */
const hookEnv = (extra: Record<string, string> = {}) => ({
  PATH: "/usr/bin:/bin",
  HOME: home(),
  CLAUDE_CODE_SESSION_ID: "",
  CLAUDE_PID: "",
  ...extra,
});

/** `command` through `sh -c`, as Claude Code runs a hook's command. */
const shell = (cwd: string, command: string, env: Record<string, string> = {}) =>
  run(cwd, ["/bin/sh", "-c", command], hookEnv(env));

/** `mshape <args>` as a skill or hook runs it, with `mshape` found as a hook finds it. */
const mshape = (cwd: string, args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  shell(cwd, withMshape(mshapeCommand(args)), env);

const hookFor = (event: string, args: string) => {
  const found = HOOKS.find((hook) => hook.event === event && hook.command.includes(args));
  if (found === undefined) throw new Error(`no ${event} hook running ${args}`);
  return found.command;
};

beforeAll(async () => {
  if (host === undefined) return;
  work = await realpath(await mkdtemp(join(tmpdir(), "mshape-invoke-")));
  born = await initFromSource(work, ["demo", "--from", await pack(work)]);
  repo = join(work, "demo");
  // The compiled mshape of this checkout, where install.sh puts it.
  const version = packVersion(await Effect.runPromise(packSource(ROOT)));
  const [binary = ""] = await Effect.runPromise(
    compileBinaries(ROOT, join(work, "release"), version, [host]),
  );
  await mkdir(join(home(), ".local", "bin"), { recursive: true });
  await copyFile(binary, join(home(), ".local", "bin", "mshape"));
  await run(repo, [
    process.execPath,
    join(repo, "node_modules", ".bin", "mshape"),
    "track",
    "new",
    "a",
  ]);
  await rm(join(worktree(), "node_modules"), { recursive: true, force: true });
}, 240_000);

afterAll(async () => {
  if (work !== "") await rm(work, { recursive: true, force: true });
});

describe.skipIf(host === undefined)("running mshape from a hook, with no Bun", () => {
  test("the born repo and its track exist, and the hook's PATH has neither bun nor mshape", async () => {
    expect(born.code).toBe(0);
    expect(unexpectedNotes(born.output)).toEqual([]);
    expect((await shell(repo, "command -v bun || command -v mshape")).code).not.toBe(0);
  });

  test("finds ~/.local/bin/mshape, from the repo root and a subdirectory", async () => {
    for (const cwd of [repo, join(repo, "test")]) {
      const outside = await mshape(cwd, ["track", "current"]);
      expect(outside.output).toContain("is not a track worktree");
      expect(outside.code).toBe(1);
    }
  });

  test("from a track worktree with no node_modules, runs there", async () => {
    expect(await Bun.file(join(worktree(), "node_modules")).exists()).toBe(false);
    const current = await mshape(worktree(), ["track", "current"]);
    expect(current.output).toBe("a\n");
    expect(current.code).toBe(0);
  });

  test("passes arguments through intact and prints nothing of its own", async () => {
    const unknown = await mshape(repo, ["it's two words"]);
    expect(unknown.output).toStartWith("mshape: unknown command 'it's two words'\n");
    expect(unknown.code).toBe(2);
  });

  test("the born repo's hooks register a session and deliver its mail", async () => {
    const session = {
      CLAUDE_CODE_SESSION_ID: crypto.randomUUID(),
      CLAUDE_PID: String(process.pid),
    };
    const registered = await shell(worktree(), hookFor("SessionStart", "msg register"), session);
    expect(registered.output).not.toContain("note:");
    expect(registered.code).toBe(0);
    const sent = await mshape(repo, ["msg", "send", "a", "--subject", "from main", "a body"]);
    expect(sent.code).toBe(0);
    const inbox = await shell(worktree(), hookFor("UserPromptSubmit", "msg inbox"), session);
    expect(inbox.output).toContain("from main");
    expect(inbox.code).toBe(0);
  });

  test("with no mshape installed, a hook prints the install line and exits 0", async () => {
    const bare = await shell(repo, hookFor("UserPromptSubmit", "msg inbox"), {
      HOME: join(work, "nobody"),
    });
    expect(bare.output).toContain(`curl -fsSL ${INSTALL_URL} | sh`);
    expect(bare.code).toBe(0);
  });

  test("the gate the born AGENTS.md names passes with the installed mshape, and its paths exist", async () => {
    const agents = await Bun.file(join(repo, "AGENTS.md")).text();
    const row = agents.split("\n").find((line) => /^\| `[^`]+` \| The gate/.test(line)) ?? "";
    const command = /`([^`]+)`/.exec(row)?.[1] ?? "";
    expect(command).toStartWith("mshape ");
    // The TypeScript pack's tools run on Bun: it is on this PATH, mshape is not.
    const gate = await mshape(repo, command.split(" ").slice(1), {
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    });
    expect(gate.output).toContain("mshape gate passed");
    expect(gate.code).toBe(0);
    const start = agents.slice(agents.indexOf("## Where to start"));
    const paths = [...start.slice(0, start.indexOf("\n## ", 1)).matchAll(/^- `([^`]+)`/gm)].map(
      (match) => match[1] ?? "",
    );
    expect(paths).toContain("shape.toml");
    for (const path of paths)
      expect({ path, exists: await exists(join(repo, path)) }).toEqual({ path, exists: true });
  }, 120_000);
});
