/**
 * The plan's Harness selection table, a test per row: `harnesses` in `shape.toml`, and what
 * `mshape sync` and `mshape check` make of it in a real directory. Codex's adapter is its own
 * track's, so a second harness here is a stand-in that writes a whole file, as pi's will.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { loadConfig } from "../../src/adapters/config.ts";
import { listedHarnesses } from "../../src/adapters/harnesses/index.ts";
import { type HarnessSelection, harnessSelection, syncRepo } from "../../src/adapters/sync.ts";
import { PR_TEMPLATE_FILE, prTemplate } from "../../src/core/conventions.ts";
import { checkSync, harnessDeliveries } from "../../src/core/sync.ts";
import { CLAUDE_HOOKS, SETTINGS_FILE } from "../../src/harnesses/claude-code/index.ts";
import type { Harness } from "../../src/harnesses/harness.ts";
import { HARNESSES } from "../../src/harnesses/index.ts";
import { resolveConfig } from "../../src/schemas/config.ts";
import { repo as snapshotOf } from "../support.ts";

let dir = "";
const pkg = () => join(dir, "pkg");
const root = () => join(dir, "repo");
const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};
const read = (path: string) => Bun.file(join(root(), path)).text();
const exists = (path: string) =>
  lstat(join(root(), path)).then(
    () => true,
    () => false,
  );

/** A harness that writes one file whole, as pi's extension: stands in for a second one. */
const EXTENSION = { path: ".other/extension.ts", text: "// monkeyshape's extension\n" };
const other: Harness = {
  id: "pi",
  name: "Other",
  moments: ["session-start"],
  files: (hooks) => (hooks.length === 0 ? [] : [{ kind: "whole", ...EXTENSION }]),
  skills: { kind: "native" },
  identify: () => undefined,
  invoke: (skill) => `/${skill}`,
  identifiedBy: "nothing",
};
const shipped = [...HARNESSES, other];
const sync = (listed: HarnessSelection["listed"]) =>
  Effect.runPromise(syncRepo(root(), pkg(), [], [], { shipped, listed }));
const config = () => Effect.runPromise(Effect.result(loadConfig(root())));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-harnesses-"));
  await put(join(pkg(), "template", ".beads", "PRIME.md"), "# The working loop\n");
  await mkdir(root(), { recursive: true });
  Bun.spawnSync(["git", "init", "--quiet"], { cwd: root() });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("Harness selection: the plan's table", () => {
  test("no harnesses key (every 0.6 repo): claude-code, and sync and check as before", async () => {
    await put(join(root(), "shape.toml"), 'packs = ["typescript"]\n');
    const loaded = await config();
    expect(loaded._tag === "Success" && loaded.success.harnesses).toEqual(["claude-code"]);
    expect(await Effect.runPromise(harnessSelection(root()))).toEqual({
      shipped: HARNESSES,
      listed: ["claude-code"],
    });
    const plan = await sync(["claude-code"]);
    expect([...plan.write.keys()]).toContain(SETTINGS_FILE);
    expect(JSON.parse(await read(SETTINGS_FILE)).hooks.SessionStart[0].hooks[0].command).toBe(
      CLAUDE_HOOKS[0]?.command,
    );
  });

  test("only another harness: its file delivered, and no .claude/ written", async () => {
    const plan = await sync(["pi"]);
    expect(await read(EXTENSION.path)).toBe(EXTENSION.text);
    expect([...plan.write.keys()]).not.toContain(SETTINGS_FILE);
    expect(await exists(".claude")).toBe(false);
  });

  test("a harness id this mshape doesn't ship: fails at config load, naming the shipped ids", async () => {
    await put(join(root(), "shape.toml"), 'packs = ["typescript"]\nharnesses = ["pi"]\n');
    const loaded = await config();
    expect(loaded._tag).toBe("Failure");
    const said = loaded._tag === "Failure" ? loaded.failure.message : "";
    expect(said).toContain("harnesses: lists `pi`, which this mshape doesn't ship");
    expect(said).toContain(`it ships ${HARNESSES.map((harness) => harness.id).join(", ")}`);
  });

  test("a harness removed from the list: sync removes what it wrote, never the repo's own", async () => {
    await sync(["claude-code", "pi"]);
    // The repo's own hook and key in Claude Code's file, beside monkeyshape's.
    const settings = JSON.parse(await read(SETTINGS_FILE));
    settings.permissions = { allow: ["Bash(ls)"] };
    settings.hooks.Stop = [{ matcher: "", hooks: [{ type: "command", command: "echo mine" }] }];
    await put(join(root(), SETTINGS_FILE), JSON.stringify(settings));
    await put(join(root(), "notes.md"), "the repo's own\n");

    const plan = await sync(["pi"]);
    expect(plan.write.has(SETTINGS_FILE)).toBe(true);
    expect(JSON.parse(await read(SETTINGS_FILE))).toEqual({
      hooks: { Stop: settings.hooks.Stop },
      permissions: { allow: ["Bash(ls)"] },
    });
    // And the other way: dropping the whole-file harness deletes its file, only if unchanged.
    const back = await sync(["claude-code"]);
    expect(back.remove).toEqual([EXTENSION.path]);
    expect(await exists(EXTENSION.path)).toBe(false);
    await put(join(root(), EXTENSION.path), "// edited by hand\n");
    const kept = await sync(["claude-code"]);
    expect(kept.remove).toEqual([]);
    expect(kept.notes.join("\n")).toContain(`${EXTENSION.path}: left alone`);
    expect(await read("notes.md")).toBe("the repo's own\n");
  });

  test("an owned file edited by hand: the sync check fails naming the file and the command", () => {
    const snapshot = (text: string) =>
      snapshotOf(
        { [EXTENSION.path]: text, [PR_TEMPLATE_FILE]: prTemplate() },
        {
          harnesses: shipped,
          skills: {
            link: { kind: "missing" },
            installed: new Map([["monkeyshape.json", new TextEncoder().encode("{}")]]),
            claudeDirectory: new Map(),
            shipped: new Map(),
          },
        },
      );
    const listed = { ...resolveConfig({}), harnesses: ["pi" as const] };
    expect(checkSync(listed, snapshot(EXTENSION.text))).toEqual([]);
    const [found] = checkSync(listed, snapshot("// edited\n"));
    expect(found?.rule).toBe("sync/harness-file-diverged");
    expect(found?.file).toBe(EXTENSION.path);
    expect(found?.message).toContain("Run `mshape sync`");
  });

  test("two harnesses listed: both delivered", async () => {
    const plan = await sync(["claude-code", "pi"]);
    expect([...plan.write.keys()].sort()).toEqual(
      [EXTENSION.path, SETTINGS_FILE, ".beads/PRIME.md", ".github/pull_request_template.md"]
        .filter((path) => path !== ".beads/PRIME.md")
        .sort(),
    );
    expect(
      harnessDeliveries(shipped, ["claude-code", "pi"], () => undefined).map(
        (one) => one.file.path,
      ),
    ).toEqual([SETTINGS_FILE, EXTENSION.path]);
  });
});

describe("listedHarnesses: who is asked to identify a session", () => {
  test("the nearest shape.toml's list, its default when the key is absent, nothing without one", async () => {
    expect(listedHarnesses(root())).toBeUndefined();
    await put(join(root(), "shape.toml"), 'packs = ["typescript"]\n');
    await mkdir(join(root(), "src", "deep"), { recursive: true });
    expect(listedHarnesses(join(root(), "src", "deep"))).toEqual(["claude-code"]);
    await put(join(root(), "shape.toml"), 'harnesses = ["codex"]\n');
    expect(listedHarnesses(root())).toEqual(["codex"]);
    // A config that doesn't parse asks every harness, so prime still registers the session.
    await put(join(root(), "shape.toml"), "harnesses = [\n");
    expect(listedHarnesses(root())).toBeUndefined();
  });
});
