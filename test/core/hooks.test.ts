import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { HOOKS, mshapeCommand, renderSettings, SETTINGS_FILE } from "../../src/core/hooks.ts";
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

  test("this repo's .claude/settings.json is the rendered hook list", async () => {
    // To regenerate: bun -e 'import { HOOKS, renderSettings } from "./src/core/hooks.ts";
    //   await Bun.write(".claude/settings.json", renderSettings(HOOKS))'
    expect(await Bun.file(join(ROOT, SETTINGS_FILE)).text()).toBe(renderSettings(HOOKS));
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
});
