import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { withBeadsExport } from "../../src/adapters/beads.ts";
import { repo } from "../support.ts";

let dir = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-beads-"));
  await Bun.write(
    join(dir, ".beads", "issues.jsonl"),
    `${JSON.stringify({ _type: "issue", id: "x-1", title: "t", status: "open", labels: ["track:a"] })}\n`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = (snapshot: ReturnType<typeof repo>, root = dir) =>
  Effect.runPromise(withBeadsExport(root, snapshot));

describe("withBeadsExport", () => {
  test("bd unavailable and an export: its beads, marked as read from it", async () => {
    const got = await read(repo({}, { beads: { state: "unavailable", reason: "no bd" } }));
    expect(got.beadsExport).toEqual({ path: ".beads/issues.jsonl", state: "read" });
    expect([...(got.beadIds ?? [])]).toEqual(["x-1"]);
  });

  test("bd working, or no export: the snapshot as it was", async () => {
    const ok = repo({}, { beadRows: [] });
    expect(await read(ok)).toBe(ok);
    const none = repo({}, { beads: { state: "unavailable", reason: "no bd" } });
    expect(await read(none, join(dir, "elsewhere"))).toBe(none);
  });
});
