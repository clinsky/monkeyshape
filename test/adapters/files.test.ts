/**
 * Sizes and vendored artifacts against real files: a 30 MB binary, a tarball `bun pm pack`
 * made, and a recorded file that isn't an archive at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadSizes, loadVendored } from "../../src/adapters/files.ts";
import { checkFiles } from "../../src/core/files.ts";
import { config, repo as inMemory } from "../support.ts";

let repo = "";
/** `bun pm pack`'s name for @acme/lib 1.2.0. */
const tarball = "vendor/acme-lib-1.2.0.tgz";
let digest = "";

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "mshape-files-"));
  const pkg = join(repo, "pkg");
  await mkdir(pkg);
  await writeFile(
    join(pkg, "package.json"),
    JSON.stringify({ name: "@acme/lib", version: "1.2.0" }),
  );
  await writeFile(join(pkg, "index.js"), "export const x = 1;\n");
  await Bun.$`${process.execPath} pm pack --quiet --destination ${join(repo, "vendor")}`
    .cwd(pkg)
    .quiet();
  digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(join(repo, tarball)).bytes())
    .digest("hex");
  await writeFile(join(repo, "vendor/notes.txt"), "not an archive\n");
  await writeFile(join(repo, "big.bin"), "");
  await truncate(join(repo, "big.bin"), 30 * 1024 * 1024);
  await symlink("big.bin", join(repo, "link"));
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("loadSizes", () => {
  test("a 30 MB binary is its size; a symlink to it is the link's own", async () => {
    const sizes = await Effect.runPromise(loadSizes(repo, ["big.bin", "link"]));
    expect(sizes.get("big.bin")).toBe(30 * 1024 * 1024);
    expect(sizes.get("link")).toBe("big.bin".length);
  });
});

describe("loadVendored", () => {
  const files = [tarball, "vendor/notes.txt"];
  const shape = (sha256: string, name = "@acme/lib") =>
    config({
      files: {
        vendored: [
          { path: tarball, package: name, sha256 },
          { path: "vendor/notes.txt", package: "notes", sha256 },
          { path: "vendor/gone.tgz", package: "gone", sha256 },
        ],
      },
    });

  test("a real tarball's digest and package; a text file says it isn't an archive", async () => {
    const read = await Effect.runPromise(loadVendored(repo, shape(digest), files));
    expect(read.get(tarball)).toEqual({ sha256: digest, package: { name: "@acme/lib" } });
    const notes = read.get("vendor/notes.txt");
    expect(notes?.package).toHaveProperty("unreadable");
    expect(read.has("vendor/gone.tgz")).toBe(false);
  });

  test("end to end: right record passes; wrong digest or package fails", async () => {
    const judge = async (resolved: ReturnType<typeof shape>) => {
      const vendored = await Effect.runPromise(loadVendored(repo, resolved, [tarball]));
      const snapshot = { ...inMemory({ [tarball]: "" }), vendored };
      const only = {
        ...resolved,
        files: { ...resolved.files, vendored: resolved.files.vendored.slice(0, 1) },
      };
      return checkFiles(only, snapshot).map((v) => v.rule);
    };
    expect(await judge(shape(digest))).toEqual([]);
    expect(await judge(shape("0".repeat(64)))).toEqual(["files/vendored-digest"]);
    expect(await judge(shape(digest, "@acme/other"))).toEqual(["files/vendored-package"]);
  });
});
