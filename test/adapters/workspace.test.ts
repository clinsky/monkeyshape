/**
 * The workspace adapter against real tools: a solution-style tsconfig whose files are all in
 * referenced projects, which `tsc -p` alone would report as covering nothing.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { loadSnapshot } from "../../src/adapters/workspace.ts";
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
    const snapshot = await Effect.runPromise(loadSnapshot(repo, shape));
    expect(snapshot.integrations.tsc).toEqual({ state: "ok" });
    expect([...(snapshot.typechecked ?? [])].sort()).toEqual([
      "packages/api/src/a.ts",
      "packages/core/src/c.ts",
    ]);
    const uncovered = checkCoverage(shape, snapshot).filter((v) => v.rule === "coverage/typecheck");
    expect(uncovered.map((v) => v.file)).toEqual(["scripts/orphan.ts"]);
  });
});
