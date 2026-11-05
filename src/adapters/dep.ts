/**
 * `mshape dep bump`'s writes: what `planBump` decides, then `bun install` for the lockfile and
 * the gate. Every refusal comes before anything is written.
 */
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Effect } from "effect";
import { GATE_SCRIPT } from "../core/conventions.ts";
import { planBump, type VendoredEntry } from "../core/dep.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { run } from "./process.ts";
import { fileDigest } from "./release.ts";

const CONFIG_FILE = "shape.config.ts";

/** The `name` in a tarball's `package/package.json`; undefined when it has none. */
const tarballPackage = (tarball: string) =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "mshape-dep-")));
    return yield* Effect.gen(function* () {
      const out = yield* run(dir, ["tar", "xzf", tarball, "-C", dir, "package/package.json"]);
      if (out.code !== 0) return undefined;
      const pkg: unknown = yield* Effect.promise(() =>
        Bun.file(join(dir, "package", "package.json"))
          .json()
          .catch(() => undefined),
      );
      return typeof pkg === "object" &&
        pkg !== null &&
        "name" in pkg &&
        typeof pkg.name === "string"
        ? pkg.name
        : undefined;
    }).pipe(Effect.ensuring(Effect.promise(() => rm(dir, { recursive: true, force: true }))));
  });

const read = (path: string) =>
  Effect.tryPromise({
    try: () => Bun.file(path).text(),
    catch: (cause) => new WorkspaceError({ operation: "read", path, reason: String(cause) }),
  });

export interface BumpResult {
  /** What was done, one line each, or why nothing was. */
  readonly lines: ReadonlyArray<string>;
  /** 0 moved and green; 1 refused, or moved and the gate or install failed. */
  readonly code: number;
}

/** Bumps the vendored dependency `name` in `repo` to `tarball`, whose release states `sha256`. */
export const depBump = (
  repo: string,
  vendored: ReadonlyArray<VendoredEntry>,
  name: string,
  tarball: string,
  sha256: string,
) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(tarball).exists())))
      return { lines: [`${tarball}: no such file`], code: 1 } satisfies BumpResult;
    const plan = planBump({
      vendored,
      name,
      file: basename(tarball),
      tarballPackage: yield* tarballPackage(tarball),
      actual: yield* fileDigest(tarball),
      expected: sha256,
      packageJson: yield* read(join(repo, "package.json")),
      configText: yield* read(join(repo, CONFIG_FILE)),
    });
    if ("refused" in plan)
      return { lines: ["nothing changed:", ...plan.refused], code: 1 } satisfies BumpResult;
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(join(repo, "vendor"), { recursive: true });
        await copyFile(tarball, join(repo, plan.to.path));
        if (plan.from.path !== plan.to.path) await rm(join(repo, plan.from.path), { force: true });
        await Bun.write(join(repo, "package.json"), plan.packageJson);
        await Bun.write(join(repo, CONFIG_FILE), plan.configText);
      },
      catch: (cause) =>
        new WorkspaceError({ operation: "dep bump", path: repo, reason: String(cause) }),
    });
    const lines = [
      `${name}: ${plan.from.path} -> ${plan.to.path}, sha256 ${plan.to.sha256}`,
      `updated package.json and ${CONFIG_FILE}`,
    ];
    const install = yield* run(repo, [process.execPath, "install"]);
    if (install.code !== 0)
      return {
        lines: [
          ...lines,
          `bun install failed, so bun.lock is not updated; fix it, then \`bun install\`:`,
          `${install.stdout}${install.stderr}`.trim(),
        ],
        code: 1,
      } satisfies BumpResult;
    lines.push("bun install: bun.lock updated");
    const gate = yield* run(repo, [process.execPath, "run", GATE_SCRIPT]);
    const tail = `${gate.stdout}${gate.stderr}`.trim().split("\n").slice(-15).join("\n");
    return gate.code === 0
      ? ({
          lines: [...lines, "gate passed: review the diff and commit it"],
          code: 0,
        } satisfies BumpResult)
      : ({
          lines: [
            ...lines,
            "the gate fails on the new version; the change is left for you to fix or revert:",
            tail,
          ],
          code: 1,
        } satisfies BumpResult);
  });
