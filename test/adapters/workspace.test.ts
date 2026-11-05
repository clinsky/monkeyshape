/**
 * The workspace adapter against real tools: a solution-style tsconfig whose files are all in
 * referenced projects, which `tsc -p` alone would report as covering nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadSnapshot, noDatabaseNote } from "../../src/adapters/workspace.ts";
import { checkCoverage } from "../../src/core/coverage.ts";
import { config } from "../support.ts";

const ROOT = join(import.meta.dir, "..", "..");
let repo = "";

const write = async (path: string, text: string) => {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
};

const project = (references: ReadonlyArray<string>) =>
  JSON.stringify({
    compilerOptions: { composite: true, types: [] },
    include: ["src"],
    references: references.map((path) => ({ path })),
  });

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "mshape-refs-"));
  await symlink(join(ROOT, "node_modules"), join(repo, "node_modules"));
  await write(".gitignore", "node_modules\n");
  // A diamond: the root and `api` both reference `core`, which must be listed once.
  await write(
    "tsconfig.json",
    JSON.stringify({
      files: [],
      references: [{ path: "./packages/api" }, { path: "./packages/core" }],
    }),
  );
  await write("packages/api/tsconfig.json", project(["../core"]));
  await write("packages/core/tsconfig.json", project([]));
  await write("packages/api/src/a.ts", "export const a = 1;\n");
  await write("packages/core/src/c.ts", "export const c = 1;\n");
  await write("scripts/orphan.ts", "export const o = 1;\n");
  await Bun.$`git init -q`.cwd(repo);
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("typecheck coverage through project references", () => {
  test("files in referenced projects are covered; a file in no project is not", async () => {
    const shape = config();
    const snapshot = await Effect.runPromise(loadSnapshot(repo, shape, `${repo}/no-package`));
    expect(snapshot.integrations.tsc).toEqual({ state: "ok" });
    expect([...(snapshot.typechecked ?? [])].sort()).toEqual([
      "packages/api/src/a.ts",
      "packages/core/src/c.ts",
    ]);
    const uncovered = checkCoverage(shape, snapshot).filter((v) => v.rule === "coverage/typecheck");
    expect(uncovered.map((v) => v.file)).toEqual(["scripts/orphan.ts"]);
  });
});

describe("the note for a clone with no beads database", () => {
  const REMOTE = "git+https://example.com/team/repo.git";

  test("a committed issues.jsonl: bootstrap is safe, and the note names both sources in bd's order", () => {
    const note = noDatabaseNote({ remote: REMOTE, local: ".beads/issues.jsonl" });
    expect(note).toContain("run `bd bootstrap`");
    expect(note).toContain(REMOTE);
    expect(note).toContain(".beads/issues.jsonl");
    // It doesn't claim the remote is what bootstrap will use: offline, it can't know.
    expect(note).not.toContain(`fetches the beads from ${REMOTE}`);
    expect(note).not.toContain("don't run `bd bootstrap`");
  });

  test("no remote configured, a committed issues.jsonl: bootstrap rebuilds from it", () => {
    const note = noDatabaseNote({ remote: undefined, local: ".beads/issues.jsonl" });
    expect(note).toContain("rebuilds the database from .beads/issues.jsonl");
    expect(note).not.toContain("example.com");
    expect(note).not.toContain("don't run `bd bootstrap`");
  });

  test("a backup is a local source too", () => {
    expect(noDatabaseNote({ remote: undefined, local: ".beads/backup/issues.jsonl" })).toContain(
      ".beads/backup/issues.jsonl",
    );
  });

  test("only a remote: bootstrap fetches from it, as before", () => {
    expect(noDatabaseNote({ remote: REMOTE, local: undefined })).toBe(
      `this clone has no beads database yet; run \`bd bootstrap\`, which fetches the beads from ${REMOTE}`,
    );
  });

  test("neither: the warning that bootstrap would hide the beads, as before", () => {
    const note = noDatabaseNote({ remote: undefined, local: undefined });
    expect(note).toContain("git ls-remote origin refs/dolt/data");
    expect(note).toContain("don't run `bd bootstrap`");
  });
});
