import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  addHooks,
  missingHooks,
  mshapeCommand,
  renderSettings,
  SYNC_COMMAND,
  settingsHooks,
} from "../../src/core/hooks.ts";
import { INSTALL_URL } from "../../src/core/launch.ts";
import { scaffold } from "../../src/core/scaffold.ts";
import { CLAUDE_HOOKS as HOOKS, SETTINGS_FILE } from "../../src/harnesses/claude-code/index.ts";
import { HARNESSES } from "../../src/harnesses/index.ts";

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

  test("0.6's three SessionStart hooks and its prompt hook become 0.7's two; the repo's own stay", async () => {
    // This repo's .claude/settings.json as 0.6 wrote it, plus a hook of the repo's own.
    const old = await Bun.file(join(import.meta.dir, "..", "fixtures", "settings-0.6.json")).json();
    const own = { matcher: "", hooks: [{ type: "command", command: "echo mine" }] };
    old.hooks.SessionStart.push(own);
    const synced = JSON.parse(addHooks(old, HOOKS));
    expect(synced.hooks.SessionStart).toEqual([
      own,
      { matcher: "", hooks: [{ type: "command", command: HOOKS[0]?.command }] },
    ]);
    expect(synced.hooks.UserPromptSubmit).toEqual([
      { matcher: "", hooks: [{ type: "command", command: HOOKS[1]?.command }] },
    ]);
    expect(missingHooks(synced, HOOKS)).toEqual([]);
  });

  test("init writes the rendered settings.json, whatever the template carries", async () => {
    expect(await Bun.file(join(ROOT, "template", SETTINGS_FILE)).exists()).toBe(false);
    const claude = HARNESSES.filter((harness) => harness.id === "claude-code");
    const files = scaffold(
      "my-app",
      new Map([[SETTINGS_FILE, "{}"]]),
      toolchain,
      undefined,
      "typescript",
      undefined,
      claude,
    );
    expect(files.get(SETTINGS_FILE)).toBe(renderSettings(HOOKS));
  });

  test("hooks and skills run the installed mshape, arguments quoted (D-run-mshape)", () => {
    expect(mshapeCommand(["msg", "inbox"])).toBe("mshape msg inbox");
    expect(mshapeCommand(["msg", "send", "docs", "--subject", "it's done"])).toBe(
      `mshape msg send docs --subject 'it'\\''s done'`,
    );
    expect(SYNC_COMMAND).toBe("mshape sync");
  });

  test("every hook degrades to a note and exits 0 where it can't run", async () => {
    // A machine with the hooks and nothing installed: no mshape, no bd.
    const dir = await mkdtemp(join(tmpdir(), "mshape-hooks-"));
    try {
      for (const hook of HOOKS) {
        const ran = Bun.spawnSync(["/bin/sh", "-c", hook.command], {
          cwd: dir,
          env: { PATH: "/usr/bin:/bin", HOME: dir },
        });
        expect({ command: hook.command, code: ran.exitCode }).toEqual({
          command: hook.command,
          code: 0,
        });
        expect(ran.stdout.toString()).toStartWith("note: ");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a hook finds mshape when it runs: PATH, then ~/.local/bin, else the install line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mshape-hooks-mshape-"));
    // A fake mshape that says which one ran; `fails` exits 1, as the launcher does offline.
    const fakeMshape = async (at: string, fails = false) => {
      await mkdir(at, { recursive: true });
      await Bun.write(
        join(at, "mshape"),
        `#!/bin/sh\necho "ran ${at}"\n${fails ? "exit 1\n" : ""}`,
      );
      await chmod(join(at, "mshape"), 0o755);
    };
    const onPath = join(dir, "path-bin");
    const home = join(dir, "home");
    const broken = join(dir, "broken");
    await fakeMshape(onPath);
    await fakeMshape(join(home, ".local", "bin"));
    await fakeMshape(broken, true);
    const hook = HOOKS.find((candidate) => candidate.command.includes(" prime"));
    if (hook === undefined) throw new Error("no prime hook");
    const runHook = (PATH: string, HOME: string) => {
      const ran = Bun.spawnSync(["/bin/sh", "-c", hook.command], { cwd: dir, env: { PATH, HOME } });
      return { code: ran.exitCode, out: ran.stdout.toString().trim() };
    };
    const system = "/usr/bin:/bin";
    const noHome = join(dir, "no-home");
    try {
      // The plan's table, a row each.
      expect(runHook(`${onPath}:${system}`, home)).toEqual({ code: 0, out: `ran ${onPath}` });
      expect(runHook(system, home)).toEqual({ code: 0, out: `ran ${home}/.local/bin` });
      const neither = runHook(system, noHome);
      expect(neither.code).toBe(0);
      expect(neither.out).toStartWith(
        "note: mshape is neither on this session's PATH nor in ~/.local/bin",
      );
      expect(neither.out).toContain(`curl -fsSL ${INSTALL_URL} | sh`);
      // mshape found but failing (offline, say): a note, still exit 0.
      const failing = runHook(`${broken}:${system}`, noHome);
      expect(failing.code).toBe(0);
      expect(failing.out).toContain("note: mshape could not run here");
      // The committed settings name no machine's paths, and no bun.
      for (const each of HOOKS) {
        expect(each.command).not.toContain(homedir());
        expect(each.command).not.toContain(process.execPath);
        expect(each.command).not.toContain("bun run");
      }
      expect(hook.command).toContain('"$PATH:$HOME/.local/bin"');
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

test("the loop's shipped text names mshape, never bun run, outside the TypeScript pack", async () => {
  // A Rust or Python repo has no package.json: `bun run` there fails refs/unknown-script.
  const shipped = [
    ...new Bun.Glob("skills/**/*.md").scanSync({ cwd: ROOT }),
    ...new Bun.Glob("template/**/*.md").scanSync({ cwd: ROOT, dot: true }),
  ].filter((file) => !file.startsWith("template/packs/typescript/"));
  expect(shipped).toContain("template/.beads/PRIME.md");
  const found: Array<string> = [];
  for (const file of shipped) {
    const text = await Bun.file(join(ROOT, file)).text();
    text.split("\n").forEach((line, index) => {
      if (/\bbun run\b/.test(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  expect(found).toEqual([]);
});
