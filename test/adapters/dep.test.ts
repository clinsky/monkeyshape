import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { depBump } from "../../src/adapters/dep.ts";

let dir = "";
const repo = () => join(dir, "repo");

/** Packs a one-file package `name@version` into `dir`; its path and sha256. */
const release = async (name: string, version: string) => {
  const src = join(dir, `${name}-${version}-src`);
  await Bun.write(join(src, "package.json"), JSON.stringify({ name, version }));
  await Bun.write(join(src, "index.js"), `export const version = "${version}";\n`);
  const out = Bun.spawnSync([process.execPath, "pm", "pack", "--destination", dir, "--quiet"], {
    cwd: src,
  });
  const path = join(dir, out.stdout.toString().trim().split("/").at(-1) ?? "");
  const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(path).bytes()).digest("hex");
  return { path, sha256 };
};

let old = { path: "", sha256: "" };
const record = () => [{ path: "vendor/app-1.0.0.tgz", package: "app", sha256: old.sha256 }];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-dep-"));
  old = await release("app", "1.0.0");
  await Bun.write(join(repo(), "vendor", "app-1.0.0.tgz"), Bun.file(old.path));
  await Bun.write(
    join(repo(), "package.json"),
    JSON.stringify({
      name: "born",
      private: true,
      scripts: { check: "bun -e 'process.exit(0)'" },
    }),
  );
  await Bun.write(
    join(repo(), "shape.config.ts"),
    `export default { files: { vendored: [{ path: "vendor/app-1.0.0.tgz", package: "app", sha256: "${old.sha256}" }] } };\n`,
  );
  // The dependency as an adopter adds it, so bump meets the spec bun writes.
  Bun.spawnSync([process.execPath, "add", "./vendor/app-1.0.0.tgz"], { cwd: repo() });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const installed = () => Bun.file(join(repo(), "node_modules", "app", "package.json")).json();

describe("depBump on a born repo's vendored dependency", () => {
  test("a wrong digest is refused, and nothing changes", async () => {
    const next = await release("app", "1.1.0");
    const before = await Bun.file(join(repo(), "shape.config.ts")).text();
    const result = await Effect.runPromise(
      depBump(repo(), record(), "app", next.path, "0".repeat(64)),
    );
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("not that release");
    expect(await Bun.file(join(repo(), "shape.config.ts")).text()).toBe(before);
    expect(await Bun.file(join(repo(), "vendor", "app-1.1.0.tgz")).exists()).toBe(false);
    expect((await installed()).version).toBe("1.0.0");
  });

  test("the right digest moves the tarball, package.json, lockfile and record, and runs the gate", async () => {
    const next = await release("app", "1.1.0");
    const result = await Effect.runPromise(
      depBump(repo(), record(), "app", next.path, next.sha256),
    );
    expect(result.lines.join("\n")).toContain("gate passed");
    expect(result.code).toBe(0);
    expect(await Bun.file(join(repo(), "vendor", "app-1.0.0.tgz")).exists()).toBe(false);
    expect(await Bun.file(join(repo(), "vendor", "app-1.1.0.tgz")).exists()).toBe(true);
    const pkg = await Bun.file(join(repo(), "package.json")).json();
    // In the form bun add wrote it.
    expect(pkg.dependencies.app).toBe("./vendor/app-1.1.0.tgz");
    const config = await Bun.file(join(repo(), "shape.config.ts")).text();
    expect(config).toContain(`path: "vendor/app-1.1.0.tgz"`);
    expect(config).toContain(next.sha256);
    expect(await Bun.file(join(repo(), "bun.lock")).text()).toContain("app-1.1.0.tgz");
    expect((await installed()).version).toBe("1.1.0");
  });

  test("a release of another package is refused, even with its own right digest", async () => {
    const other = await release("other", "1.1.0");
    const result = await Effect.runPromise(
      depBump(repo(), record(), "app", other.path, other.sha256),
    );
    expect(result.code).toBe(1);
    expect(result.lines.join("\n")).toContain("is the package other, not app");
  });
});
