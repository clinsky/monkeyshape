/**
 * File modes and declared commands against a real git repo and real programs: git's
 * executable bit, the disk's for untracked files, and each way a command can turn out.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadModes, runCommands } from "../../src/adapters/commands.ts";
import type { DeclaredCommand } from "../../src/schemas/config.ts";
import { config } from "../support.ts";

let repo = "";

const write = async (path: string, text: string, mode = 0o644) => {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
  await chmod(join(repo, path), mode);
};

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "mshape-commands-"));
  await write(".github/scripts/release", "#!/bin/sh\n", 0o755);
  await write("tools/gen.py", "print(1)\n");
  await write("scripts/check.sh", "#!/bin/sh\necho checked\n", 0o755);
  await symlink("tools", join(repo, "linked"));
  await Bun.$`git init -q && git add .github tools linked && git -c user.name=t -c user.email=t@t commit -qm init`.cwd(
    repo,
  );
  // Untracked: only the disk can say.
  await write("bin/run", "#!/bin/sh\n", 0o755);
  // Tracked as plain, then made executable on disk: git's mode wins.
  await write("tools/plain.sh", "", 0o644);
  await Bun.$`git add tools/plain.sh && chmod 755 tools/plain.sh`.cwd(repo);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("loadModes", () => {
  test("git's mode for tracked files, the disk's for untracked ones", async () => {
    const files = [
      ".github/scripts/release",
      "tools/gen.py",
      "tools/plain.sh",
      "linked",
      "bin/run",
      "scripts/check.sh",
    ];
    const modes = await Effect.runPromise(loadModes(repo, files));
    expect(Object.fromEntries(modes)).toEqual({
      ".github/scripts/release": "executable",
      linked: "symlink",
      "bin/run": "executable",
      "scripts/check.sh": "executable",
    });
  });
});

describe("runCommands", () => {
  const outcomes = async (commands: ReadonlyArray<DeclaredCommand>) => {
    const shape = config({ coverage: { commands } });
    const runs = await Effect.runPromise(runCommands(repo, shape, ["tools/gen.py"]));
    return commands.map((_, index) => runs.get(index));
  };

  test("exit 0 and 1 ran; a missing program, a missing path and exit 127 are unavailable", async () => {
    const tools = ["tools/**"];
    const [ok, failed, notOnPath, noPath, notFound, unmatched] = await outcomes([
      { files: tools, run: ["sh", "-c", "echo fine"] },
      { files: tools, run: ["sh", "-c", "echo 'gen.py:1: error' >&2; exit 1"] },
      { files: tools, run: ["mshape-no-such-tool"] },
      { files: tools, run: ["./scripts/missing.sh"] },
      { files: tools, run: ["sh", "-c", "mshape-no-such-tool --check"] },
      { files: ["elsewhere/**"], run: ["sh", "-c", "exit 1"] },
    ]);
    expect(ok).toEqual({ state: "ran", code: 0, output: "fine\n" });
    expect(failed).toEqual({ state: "ran", code: 1, output: "gen.py:1: error\n" });
    expect(notOnPath).toEqual({
      state: "unavailable",
      reason: "`mshape-no-such-tool` is not on PATH",
    });
    expect(noPath).toEqual({
      state: "unavailable",
      reason: "`./scripts/missing.sh` does not exist",
    });
    expect(notFound?.state).toBe("unavailable");
    expect(notFound?.state === "unavailable" && notFound.reason).toContain("exited 127");
    expect(unmatched).toBeUndefined();
  });

  test("a repo script by path, and bun as the running bun", async () => {
    const [script, bun] = await outcomes([
      { files: ["tools/**"], run: ["scripts/check.sh"] },
      { files: ["tools/**"], run: ["bun", "-e", "console.log(typeof Bun)"] },
    ]);
    expect(script).toEqual({ state: "ran", code: 0, output: "checked\n" });
    expect(bun).toEqual({ state: "ran", code: 0, output: "object\n" });
  });
});

describe("declared commands run only when coverage is selected", () => {
  test("check --only budgets and garden run none; coverage and everything run each once", async () => {
    const { loadSnapshot } = await import("../../src/adapters/workspace.ts");
    const { CHECK_NAMES } = await import("../../src/schemas/config.ts");
    await writeFile(join(repo, ".gitignore"), "runs.log\n");
    const shape = config({
      coverage: { commands: [{ files: ["tools/**"], run: ["sh", "-c", "echo ran >> runs.log"] }] },
    });
    const runs = async () =>
      (
        await Bun.file(join(repo, "runs.log"))
          .text()
          .catch(() => "")
      )
        .split("\n")
        .filter(Boolean).length;
    const load = (checks: ReadonlyArray<(typeof CHECK_NAMES)[number]>) =>
      Effect.runPromise(loadSnapshot(repo, shape, `${repo}/no-package`, { checks }));

    const budgets = await load(["budgets"]);
    await load([]);
    expect(await runs()).toBe(0);
    expect(budgets.commands.size).toBe(0);
    expect(budgets.integrations.tsc.state).toBe("unavailable");

    const coverage = await load(["coverage"]);
    expect(await runs()).toBe(1);
    expect(coverage.commands.get(0)).toEqual({ state: "ran", code: 0, output: "" });
    await load(CHECK_NAMES);
    expect(await runs()).toBe(2);
  });
});

describe("exit 127 from adoption's literal run", () => {
  const judge = async (commands: ReadonlyArray<DeclaredCommand>) => {
    const shape = config({ coverage: { commands } });
    const runs = await Effect.runPromise(runCommands(repo, shape, ["tools/gen.py"]));
    return commands.map((_, index) => runs.get(index));
  };

  test("a file it was given is missing: failed, with bash's own words, never unavailable", async () => {
    const [missingFile] = await judge([
      { files: ["tools/**"], run: ["bash", "-n", "tools/gone.sh"] },
    ]);
    expect(missingFile?.state).toBe("ran");
    expect(missingFile?.state === "ran" && missingFile.code).toBe(127);
    expect(missingFile?.state === "ran" && missingFile.output).toContain(
      "No such file or directory",
    );
  });

  test("a script whose env interpreter is missing: unavailable, without running it", async () => {
    await write("scripts/check-tool", "#!/usr/bin/env mshape-no-such-tool\nprint('hi')\n", 0o755);
    await write("scripts/check-abs", "#!/opt/mshape-no-such/bin/tool\n", 0o755);
    await write("scripts/check-flags", "#!/usr/bin/env -S mshape-no-such-tool --flag\n", 0o755);
    const [envShebang, absShebang, splitShebang, envArgv, deepEnv, missingFile] = await judge([
      { files: ["tools/**"], run: ["scripts/check-tool"] },
      { files: ["tools/**"], run: ["scripts/check-abs"] },
      { files: ["tools/**"], run: ["scripts/check-flags"] },
      { files: ["tools/**"], run: ["env", "mshape-no-such-tool", "--check"] },
      { files: ["tools/**"], run: ["sh", "-c", "env mshape-no-such-tool --check"] },
      { files: ["tools/**"], run: ["bash", "-n", "tools/gone.sh"] },
    ]);
    expect(envShebang).toEqual({
      state: "unavailable",
      reason: "`mshape-no-such-tool`, the interpreter of `scripts/check-tool`, is not on PATH",
    });
    expect(absShebang).toEqual({
      state: "unavailable",
      reason:
        "`/opt/mshape-no-such/bin/tool`, the interpreter of `scripts/check-abs`, does not exist",
    });
    expect(splitShebang?.state).toBe("unavailable");
    expect(envArgv).toEqual({
      state: "unavailable",
      reason: "`mshape-no-such-tool` is not on PATH",
    });
    expect(deepEnv?.state).toBe("unavailable");
    expect(missingFile?.state).toBe("ran");
  });

  test("env flags that take a value are never read as the program: the command runs", async () => {
    await write("scripts/env-u", "#!/usr/bin/env -S -u HOME bash\nexit 3\n", 0o755);
    const [unset, chdir, shebang, clean, missingAfterFlag] = await judge([
      { files: ["tools/**"], run: ["env", "-u", "HOME", "sh", "-c", "exit 3"], optional: true },
      { files: ["tools/**"], run: ["env", "-C", "/tmp", "sh", "-c", "exit 3"], optional: true },
      { files: ["tools/**"], run: ["scripts/env-u"], optional: true },
      { files: ["tools/**"], run: ["env", "-i", "PATH=/usr/bin:/bin", "sh", "-c", "exit 3"] },
      { files: ["tools/**"], run: ["env", "-u", "HOME", "mshape-no-such-tool"], optional: true },
    ]);
    expect(unset).toMatchObject({ state: "ran", code: 3 });
    expect(chdir).toMatchObject({ state: "ran", code: 3 });
    expect(shebang).toMatchObject({ state: "ran", code: 3 });
    expect(clean).toMatchObject({ state: "ran", code: 3 });
    // Not judged in advance, but env's own message still says the program is missing.
    expect(missingAfterFlag?.state).toBe("unavailable");
  });

  test("a program it runs is not found, by sh's or bash's words: unavailable", async () => {
    const [sh, bash] = await judge([
      { files: ["tools/**"], run: ["sh", "-c", "mshape-no-such-tool"] },
      { files: ["tools/**"], run: ["bash", "-c", "mshape-no-such-tool"] },
    ]);
    expect(sh?.state).toBe("unavailable");
    expect(bash?.state).toBe("unavailable");
  });
});
