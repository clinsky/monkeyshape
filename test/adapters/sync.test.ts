import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { syncAll } from "../../src/adapters/sync.ts";
import { PR_TEMPLATE_FILE, PRIME_FILE, prTemplate } from "../../src/core/conventions.ts";

let dir = "";
const pkg = () => join(dir, "package");
const repo = () => join(dir, "repo");
const OWN_TEMPLATE = "## Summary\n\n## How to test\n";
const MANIFEST = ".agents/skills/monkeyshape.json";

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};
const read = (root: string, file: string) => Bun.file(join(root, file)).text();
const git = (cwd: string, ...args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", ...args], { cwd });
  if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
};
const sync = (root: string, files: ReadonlyArray<string> = []) =>
  Effect.runPromise(syncAll(root, pkg(), { files, skills: [] }));
const recorded = async (root: string) => JSON.parse(await read(root, MANIFEST)).files;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-sync-"));
  await put(join(pkg(), "template", PRIME_FILE), "# The working loop, v1\n");
  await put(join(pkg(), "skills", "track", "SKILL.md"), "track\n");
  // An adopter's repo: beads, and a PR template of its own.
  await put(join(repo(), ".beads", "config.yaml"), "");
  await put(join(repo(), PR_TEMPLATE_FILE), OWN_TEMPLATE);
  git(repo(), "init", "--quiet");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("sync and a PR template the adopter wrote", () => {
  test("survives sync, a fresh clone and a version bump; --replace replaces it", async () => {
    const first = await sync(repo());
    expect(await read(repo(), PR_TEMPLATE_FILE)).toBe(OWN_TEMPLATE);
    expect(first.plan.blocked.join("\n")).toContain(`${PR_TEMPLATE_FILE} is this repo's own`);
    // PRIME.md was absent, so sync wrote it, and owns it: only that is recorded.
    expect(await read(repo(), PRIME_FILE)).toBe("# The working loop, v1\n");
    expect(await recorded(repo())).toEqual([PRIME_FILE]);

    git(repo(), "add", "--all");
    git(repo(), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "sync");
    const clone = join(dir, "clone");
    git(dir, "clone", "--quiet", repo(), clone);
    await sync(clone);
    expect(await read(clone, PR_TEMPLATE_FILE)).toBe(OWN_TEMPLATE);

    // A version bump: the shipped PRIME.md changes. Sync's file follows; the adopter's doesn't.
    await put(join(pkg(), "template", PRIME_FILE), "# The working loop, v2\n");
    await sync(clone);
    expect(await read(clone, PRIME_FILE)).toBe("# The working loop, v2\n");
    expect(await read(clone, PR_TEMPLATE_FILE)).toBe(OWN_TEMPLATE);

    const replaced = await sync(clone, [PR_TEMPLATE_FILE]);
    expect(replaced.plan.blocked).toEqual([]);
    expect(await read(clone, PR_TEMPLATE_FILE)).toBe(prTemplate());
    expect(await recorded(clone)).toEqual([PRIME_FILE, PR_TEMPLATE_FILE]);
  });

  test("an adopter's template in GitHub's other spelling blocks sync from adding a second", async () => {
    await rm(join(repo(), PR_TEMPLATE_FILE));
    await put(join(repo(), ".github", "PULL_REQUEST_TEMPLATE.md"), OWN_TEMPLATE);
    const plan = (await sync(repo())).plan;
    expect(plan.blocked.join("\n")).toContain(
      ".github/PULL_REQUEST_TEMPLATE.md is a PR template too",
    );
    expect(await Bun.file(join(repo(), PR_TEMPLATE_FILE)).exists()).toBe(false);
  });

  test("--replace of a skill monkeyshape doesn't ship refuses, writing nothing", async () => {
    const exit = await Effect.runPromiseExit(
      syncAll(repo(), pkg(), { files: [], skills: ["trak"] }),
    );
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain(".agents/skills/trak");
    expect(String(exit)).toContain("It ships track");
    expect(await Bun.file(join(repo(), PRIME_FILE)).exists()).toBe(false);
  });

  test("a hand edit to a file sync owns is put back, as before", async () => {
    await sync(repo(), [PR_TEMPLATE_FILE]);
    await put(join(repo(), PR_TEMPLATE_FILE), "## Edited\n");
    const again = await sync(repo());
    expect(again.plan.blocked).toEqual([]);
    expect(await read(repo(), PR_TEMPLATE_FILE)).toBe(prTemplate());
  });

  test("a manifest from before the record owns both files, since that sync overwrote them", async () => {
    await put(join(repo(), MANIFEST), JSON.stringify({ shared: ["track"] }));
    await put(join(repo(), ".agents", "skills", "track", "SKILL.md"), "track\n");
    const plan = (await sync(repo())).plan;
    expect(plan.blocked).toEqual([]);
    expect(await read(repo(), PR_TEMPLATE_FILE)).toBe(prTemplate());
    expect(await recorded(repo())).toEqual([PRIME_FILE, PR_TEMPLATE_FILE]);
  });

  test("an unreadable manifest stops sync before it writes anything", async () => {
    await put(join(repo(), MANIFEST), JSON.stringify({ shared: [], files: ["README.md"] }));
    const exit = await Effect.runPromiseExit(syncAll(repo(), pkg()));
    expect(exit._tag).toBe("Failure");
    expect(await Bun.file(join(repo(), PRIME_FILE)).exists()).toBe(false);
  });
});
