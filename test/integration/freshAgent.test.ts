/**
 * The fresh-agent test: what an agent loads at session start, in this repo and in one `init`
 * just made, states the loop's conventions and doesn't contradict them. It runs the real
 * SessionStart hooks, so it needs bd; CI installs a pinned one, and fails rather than skips
 * without it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONVENTIONS, missingConventions, sessionContext } from "./freshAgent.ts";
import { HAS_BD, initFromSource, ROOT } from "./harness.ts";

let work = "";

beforeAll(async () => {
  if (!HAS_BD) return;
  work = await mkdtemp(join(tmpdir(), "mshape fresh "));
  await initFromSource(work, ["born"]);
}, 120_000);

afterAll(async () => {
  if (work !== "") await rm(work, { recursive: true, force: true });
});

describe("a fresh agent", () => {
  test("CI has bd, so this test runs there", () => {
    const { CI } = process.env;
    if (CI !== undefined) expect(HAS_BD).toBe(true);
  });

  test.skipIf(!HAS_BD)(
    "in this repo, is told every convention at session start",
    async () => {
      expect(missingConventions(await sessionContext(ROOT))).toEqual([]);
    },
    60_000,
  );

  test.skipIf(!HAS_BD)(
    "in a repo init just made, is told every convention",
    async () => {
      expect(missingConventions(await sessionContext(join(work, "born")))).toEqual([]);
    },
    60_000,
  );

  test("each convention is told apart: bd's default text alone states none and contradicts one", () => {
    const bdDefault =
      "Agents may commit. This is an ephemeral branch (no upstream). Do not push it unless the user says to. Use bd ready.";
    expect(missingConventions(bdDefault)).toEqual([
      ...CONVENTIONS.map((c) => `doesn't state ${c.what}`),
      'says "Do not push"',
    ]);
  });
});
