import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHooks,
  HOOKS,
  missingHooks,
  mshapeCommand,
  renderSettings,
  SETTINGS_FILE,
  settingsHooks,
} from "../../src/core/hooks.ts";
import { scaffold } from "../../src/core/scaffold.ts";

const ROOT = join(import.meta.dir, "..", "..");

const toolchain = {
  bun: "1.4.2",
  monkeyshape: "0.2.0",
  effect: "4.0.0",
  biome: "2.5.15",
  typescript: "7.0.2",
  typesBun: "1.4.2",
};

describe("hooks", () => {
  test("settings.json groups each hook under its event, in list order", () => {
    const settings = JSON.parse(
      renderSettings([
        { event: "SessionStart", matcher: "", command: "a" },
        { event: "UserPromptSubmit", matcher: "", command: "b" },
        { event: "SessionStart", matcher: "startup", command: "c" },
      ]),
    );
    expect(settings).toEqual({
      hooks: {
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "a" }] },
          { matcher: "startup", hooks: [{ type: "command", command: "c" }] },
        ],
        UserPromptSubmit: [{ matcher: "", hooks: [{ type: "command", command: "b" }] }],
      },
    });
  });

  test("this repo's .claude/settings.json hooks are the rendered hook list", async () => {
    // To regenerate, keeping the file's other keys: bun -e 'import { HOOKS, renderSettings }
    //   from "./src/core/hooks.ts"; const f = Bun.file(".claude/settings.json");
    //   await Bun.write(f, renderSettings(HOOKS, await f.json()))'
    const settings = await Bun.file(join(ROOT, SETTINGS_FILE)).json();
    expect(settings.hooks).toEqual(settingsHooks(HOOKS));
  });

  test("the hook list owns only the hooks key: other settings are kept", () => {
    const current = {
      permissions: { allow: ["Bash(bd ready)"] },
      env: { A: "1" },
      hooks: { Stop: [] },
    };
    const settings = JSON.parse(renderSettings(HOOKS, current));
    expect(settings.permissions).toEqual(current.permissions);
    expect(settings.env).toEqual(current.env);
    expect(settings.hooks).toEqual(settingsHooks(HOOKS));
  });

  test("init writes the rendered settings.json, whatever the template carries", async () => {
    expect(await Bun.file(join(ROOT, "template", SETTINGS_FILE)).exists()).toBe(false);
    const files = scaffold("my-app", new Map([[SETTINGS_FILE, "{}"]]), toolchain);
    expect(files.get(SETTINGS_FILE)).toBe(renderSettings(HOOKS));
  });

  test("mshape runs through the package script every repo has (D-run-mshape)", async () => {
    expect(mshapeCommand(["msg", "inbox"])).toBe("bun run --silent mshape msg inbox");
    expect(mshapeCommand(["msg", "send", "docs", "--subject", "it's done"])).toBe(
      `bun run --silent mshape msg send docs --subject 'it'\\''s done'`,
    );
    const born = JSON.parse(scaffold("my-app", new Map(), toolchain).get("package.json") ?? "");
    expect(born.scripts.mshape).toBe("mshape");
    const own = await Bun.file(join(ROOT, "package.json")).json();
    expect(own.scripts.mshape).toBe("bun src/cli/main.ts");
  });

  test("every hook degrades to a note and exits 0 where it can't run", async () => {
    // A repo with the hooks and nothing installed: no package script, no mshape, no bd.
    const dir = await mkdtemp(join(tmpdir(), "mshape-hooks-"));
    const bin = join(dir, "bin");
    await mkdir(bin);
    await symlink(process.execPath, join(bin, "bun"));
    try {
      for (const pkg of [undefined, JSON.stringify({ scripts: { mshape: "mshape" } })]) {
        if (pkg !== undefined) await Bun.write(join(dir, "package.json"), pkg);
        for (const hook of HOOKS) {
          const ran = Bun.spawnSync(["/bin/sh", "-c", hook.command], {
            cwd: dir,
            env: { PATH: bin },
          });
          expect({ command: hook.command, code: ran.exitCode }).toEqual({
            command: hook.command,
            code: 0,
          });
          expect(ran.stdout.toString()).toStartWith("note: ");
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a hook finds bun when it runs: PATH, then ~/.bun/bin, else a note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mshape-hooks-bun-"));
    // A fake bun that says which one ran; `fails` exits 1, as bun does with no mshape script.
    const fakeBun = async (at: string, fails = false) => {
      await mkdir(at, { recursive: true });
      await Bun.write(join(at, "bun"), `#!/bin/sh\necho "ran ${at}"\n${fails ? "exit 1\n" : ""}`);
      await chmod(join(at, "bun"), 0o755);
    };
    const empty = join(dir, "empty");
    await mkdir(empty);
    const onPath = join(dir, "path-bin");
    const home = join(dir, "home");
    const elsewhere = join(dir, "opt", "bun", "bin");
    const broken = join(dir, "broken");
    await fakeBun(onPath);
    await fakeBun(join(home, ".bun", "bin"));
    await fakeBun(elsewhere);
    await fakeBun(broken, true);
    const hook = HOOKS.find((candidate) => candidate.command.includes("msg register"));
    if (hook === undefined) throw new Error("no msg register hook");
    const runHook = (PATH: string, HOME: string) => {
      const ran = Bun.spawnSync(["/bin/sh", "-c", hook.command], { cwd: dir, env: { PATH, HOME } });
      return { code: ran.exitCode, out: ran.stdout.toString().trim() };
    };
    const noHome = join(dir, "no-home");
    try {
      // The plan's table, a row each.
      expect(runHook(onPath, home)).toEqual({ code: 0, out: `ran ${onPath}` });
      expect(runHook(empty, home)).toEqual({ code: 0, out: `ran ${home}/.bun/bin` });
      const neither = runHook(empty, noHome);
      expect(neither.code).toBe(0);
      expect(neither.out).toStartWith(
        "note: bun is neither on this session's PATH nor in ~/.bun/bin",
      );
      expect(runHook(elsewhere, noHome)).toEqual({ code: 0, out: `ran ${elsewhere}` });
      // bun found, mshape not installed: the install note, still exit 0.
      const uninstalled = runHook(broken, noHome);
      expect(uninstalled.code).toBe(0);
      expect(uninstalled.out).toContain("note: mshape could not run here");
      // The committed settings name no machine's paths: the fallback is `$HOME`, unexpanded.
      for (const each of HOOKS) {
        expect(each.command).not.toContain(homedir());
        expect(each.command).not.toContain(process.execPath);
      }
      expect(hook.command).toContain('"$PATH:$HOME/.bun/bin"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("sync replaces a hook's retired command, keeping the repo's own beside it", () => {
    const old = {
      hooks: {
        UserPromptSubmit: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "bun run --silent mshape msg inbox --quiet" },
              { type: "command", command: "echo mine" },
            ],
          },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "bd prime --hook-json" }] },
        ],
      },
    };
    const settings = JSON.parse(addHooks(old, HOOKS));
    expect(missingHooks(settings, HOOKS)).toEqual([]);
    const commands = JSON.stringify(settings);
    expect(commands).toContain("echo mine");
    for (const hook of HOOKS)
      for (const retired of hook.retired ?? [])
        expect(commands).not.toContain(`"command":"${retired}"`);
  });

  test("sync replaces a hook that still prints an earlier version's note", () => {
    // Every retired command of every hook, as a repo synced by that version has them.
    const old: Record<string, Array<unknown>> = {};
    for (const hook of HOOKS)
      for (const command of hook.retired ?? [])
        old[hook.event] = [
          ...(old[hook.event] ?? []),
          { matcher: "", hooks: [{ type: "command", command }] },
        ];
    expect(Object.values(old).flat().length).toBeGreaterThan(HOOKS.length);
    const settings = JSON.parse(addHooks({ hooks: old }, HOOKS));
    expect(settings.hooks).toEqual(settingsHooks(HOOKS));
  });
});
