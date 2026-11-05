import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
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
