/**
 * A born repo's track in a real Codex, with no model: `mshape init --harness codex`, a track,
 * then the `codex` binary's interactive TUI in the track's worktree, driven through a pty
 * (`script`). Codex talks to a local server that refuses every model request at once, so a
 * turn ends in an error within a second and nothing leaves the machine. What it shows: the
 * session-start hook loads the loop into the session and registers it at the track, and mail
 * sent to the track reaches the idle session as a turn, through `codex queue`.
 *
 * Runs where `codex` and `script` are installed (Linux); skipped elsewhere, CI included,
 * since CI has no Codex. Opening a PR through `track pr` needs GitHub and an agent: that is
 * the acceptance on a real repo, not this test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { standaloneNotice } from "../../src/core/notices.ts";
import { initFromSource, ROOT, run } from "./harness.ts";

const CODEX = Bun.which("codex");
const SCRIPT = Bun.which("script");
const RUNNABLE = CODEX !== null && SCRIPT !== null && process.platform === "linux";

const TRACK = "t1";

let work: string;
let born: string;
let worktree: string;
let codexHome: string;
let bin: string;
let dead: ReturnType<typeof Bun.serve> | undefined;
let tui: ReturnType<typeof Bun.spawn> | undefined;
let screen = "";

/** Waits for `ready` to hold, checking every 100 ms, for at most `ms`. */
const until = async (ready: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ready()) return true;
    await Bun.sleep(100);
  }
  return false;
};

/** The environment every command here runs in: the shim first on PATH, the scratch Codex home. */
const env = () => ({ PATH: `${bin}:${process.env["PATH"] ?? ""}`, CODEX_HOME: codexHome });

const mshape = (cwd: string, args: ReadonlyArray<string>) =>
  run(cwd, [process.execPath, join(ROOT, "src", "cli", "main.ts"), ...args], env());

/** Every file under `dir`, recursively; none when it doesn't exist. */
const files = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await readdir(dir, { recursive: true }).catch(() => [] as Array<string>)).map((name) =>
    join(dir, name),
  );

/** The session's rollout: every item Codex recorded, the model's input among them. */
const rollout = async (): Promise<string> => {
  const paths = (await files(join(codexHome, "sessions"))).filter((path) =>
    path.endsWith(".jsonl"),
  );
  return (await Promise.all(paths.map((path) => readFile(path, "utf8")))).join("\n");
};

/** The registrations at the track's address. */
const registrations = async (): Promise<ReadonlyArray<string>> =>
  (await files(join(born, ".git", "monkeyshape"))).filter((path) =>
    path.includes(`/sessions/${TRACK}/`),
  );

/** The TUI's input box is waiting: its terminal title says the session is idle (or errored). */
const idle = () => /state=(idle|error)[\s\S]{0,400}$/.test(screen.slice(-600));

/** Types `text` and submits it, as a human does: a burst reads as a paste, so Enter apart. */
const type = async (text: string) => {
  const stdin = tui?.stdin as import("bun").FileSink;
  stdin.write(text);
  stdin.flush();
  await Bun.sleep(500);
  stdin.write("\r");
  stdin.flush();
};

beforeAll(async () => {
  if (!RUNNABLE) return;
  work = await mkdtemp(join(tmpdir(), "mshape codex "));
  born = join(work, "born");
  codexHome = join(work, "codex-home");
  bin = join(work, "bin");
  await mkdir(codexHome);
  await mkdir(bin);
  // The hooks run `mshape` from the PATH: this checkout's.
  await writeFile(
    join(bin, "mshape"),
    `#!/bin/sh\nexec '${process.execPath}' '${join(ROOT, "src", "cli", "main.ts")}' "$@"\n`,
  );
  await chmod(join(bin, "mshape"), 0o755);

  const init = await initFromSource(work, ["--harness", "codex", "born"], env());
  if (init.code !== 0) throw new Error(`init failed:\n${init.output}`);
  const track = await mshape(born, ["track", "new", TRACK]);
  if (track.code !== 0) throw new Error(`track new failed:\n${track.output}`);
  worktree = join(born, ".agents", "worktrees", `born@${TRACK}`);
  if (!(await Bun.file(join(worktree, "AGENTS.md")).exists()))
    throw new Error(`no worktree at ${worktree}:\n${track.output}`);

  // A model endpoint that refuses at once, so a turn ends without a model or the network.
  dead = Bun.serve({
    port: 0,
    fetch: () => Response.json({ error: { message: "no model in tests" } }, { status: 400 }),
  });
  await writeFile(
    join(codexHome, "config.toml"),
    [
      'model_provider = "dead"',
      "[model_providers.dead]",
      'name = "dead"',
      `base_url = "http://127.0.0.1:${dead.port}/v1"`,
      'wire_api = "responses"',
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "supports_websockets = false",
      // Trusting the main checkout: Codex reads .codex/ there, also for a worktree.
      `[projects."${born}"]`,
      'trust_level = "trusted"',
      "",
    ].join("\n"),
  );

  tui = Bun.spawn(
    [
      SCRIPT as string,
      "-qfec",
      // A human trusts the hooks once (init says so); a test can't press the key.
      "stty cols 120 rows 40; codex --dangerously-bypass-hook-trust",
      "/dev/null",
    ],
    {
      cwd: worktree,
      env: {
        ...process.env,
        ...env(),
        CLAUDE_CODE_SESSION_ID: "",
        CLAUDE_PID: "",
        CODEX_THREAD_ID: "",
      },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  void (async () => {
    if (tui === undefined) return;
    for await (const chunk of tui.stdout as ReadableStream<Uint8Array>)
      screen += new TextDecoder().decode(chunk);
  })();
}, 300_000);

afterAll(async () => {
  tui?.kill();
  await dead?.stop(true);
  if (work !== undefined) await rm(work, { recursive: true, force: true });
});

describe.skipIf(!RUNNABLE)("a born repo's track in Codex (no model)", () => {
  test("init delivered Codex's hooks and no Claude Code settings", async () => {
    const hooks = await readFile(join(born, ".codex", "hooks.json"), "utf8");
    expect(hooks).toContain("mshape --harness codex prime");
    expect(hooks).toContain("mshape --harness codex msg inbox --quiet");
    expect(await Bun.file(join(born, ".claude", "settings.json")).exists()).toBe(false);
  });

  test("the first prompt loads the loop and registers the session at the track", async () => {
    expect(await until(() => screen.includes("Ask Codex"), 30_000)).toBe(true);
    // Codex's TUI runs the session-start hook with the first prompt, not at launch.
    expect(await registrations()).toEqual([]);
    await type("first prompt");
    expect(await until(async () => (await registrations()).length === 1, 30_000)).toBe(true);
    const [registration] = await registrations();
    expect(registration).toMatch(/\/codex\.[0-9a-f-]{36}\.json$/);
    // PRIME reached the model's input, as developer context from the hook.
    expect(await until(async () => (await rollout()).includes("The working loop"), 10_000)).toBe(
      true,
    );
  }, 120_000);

  test("mail to the track reaches the idle session as a turn", async () => {
    expect(await until(idle, 30_000)).toBe(true);
    const sent = await mshape(born, ["msg", "send", TRACK, "--subject", "probe notice", "body"]);
    expect(sent.output).toContain(`Notified 1 live session of ${TRACK}`);
    const id = /Sent (\S+) to/.exec(sent.output)?.[1] ?? "";
    const line = `[mshape] Message from main: probe notice (mshape msg read ${id})`;
    expect(
      await until(async () => (await rollout()).includes(standaloneNotice(line)), 30_000),
    ).toBe(true);
    // The prompt hook lists the unread subject beside it, as context from monkeyshape.
    expect(await rollout()).toContain(`${id}  from main`);
  }, 120_000);
});
