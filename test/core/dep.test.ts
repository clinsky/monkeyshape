import { describe, expect, test } from "bun:test";
import { type BumpInput, planBump } from "../../src/core/dep.ts";

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const CONFIG = `export default defineConfig({
  files: { vendored: [{ path: "vendor/app-1.0.0.tgz", package: "app", sha256: "${OLD}" }] },
});
`;
const PKG = JSON.stringify({
  name: "born",
  dependencies: { app: "file:./vendor/app-1.0.0.tgz", effect: "4.0.0" },
});
const input: BumpInput = {
  vendored: [{ path: "vendor/app-1.0.0.tgz", package: "app", sha256: OLD }],
  name: "app",
  file: "app-1.1.0.tgz",
  tarballPackage: "app",
  actual: NEW,
  expected: NEW,
  packageJson: PKG,
  configText: CONFIG,
};
const refusals = (overrides: Partial<BumpInput>) => {
  const plan = planBump({ ...input, ...overrides });
  return "refused" in plan ? plan.refused.join("\n") : "";
};

describe("planBump", () => {
  test("the right digest moves package.json's spec and the record, and nothing else", () => {
    const plan = planBump(input);
    if ("refused" in plan) throw new Error(plan.refused.join("\n"));
    expect(plan.to).toEqual({ path: "vendor/app-1.1.0.tgz", package: "app", sha256: NEW });
    expect(JSON.parse(plan.packageJson).dependencies).toEqual({
      app: "file:./vendor/app-1.1.0.tgz",
      effect: "4.0.0",
    });
    expect(plan.configText).toBe(
      CONFIG.replace("app-1.0.0.tgz", "app-1.1.0.tgz").replace(OLD, NEW),
    );
  });

  test("accepts the spec in each form that names the recorded file, and keeps its form", () => {
    for (const [given, moved] of [
      ["./vendor/app-1.0.0.tgz", "./vendor/app-1.1.0.tgz"],
      ["vendor/app-1.0.0.tgz", "vendor/app-1.1.0.tgz"],
      ["file:vendor/app-1.0.0.tgz", "file:vendor/app-1.1.0.tgz"],
      ["file:./vendor/app-1.0.0.tgz", "file:./vendor/app-1.1.0.tgz"],
    ]) {
      const plan = planBump({
        ...input,
        packageJson: JSON.stringify({ devDependencies: { app: given } }),
      });
      if ("refused" in plan) throw new Error(`${given}: ${plan.refused.join("\n")}`);
      expect(JSON.parse(plan.packageJson).devDependencies.app).toBe(moved);
    }
    // A spec naming another file of the same package isn't the recorded one.
    expect(
      refusals({
        packageJson: JSON.stringify({ dependencies: { app: "./vendor/app-0.9.0.tgz" } }),
      }),
    ).toContain("doesn't depend on app as the recorded tarball");
  });

  test("a digest that isn't the release's is refused, saying both", () => {
    const said = refusals({ expected: "c".repeat(64) });
    expect(said).toContain(`the tarball's sha256 is ${NEW}`);
    expect(said).toContain("not that release");
    expect(refusals({ expected: "not-a-digest" })).toContain("is not a sha256");
    // Upper-case hex from a release page is the same digest.
    expect(refusals({ expected: NEW.toUpperCase() })).toBe("");
  });

  test("a tarball of another package, or of none, is refused", () => {
    expect(refusals({ tarballPackage: "other" })).toContain("is the package other, not app");
    expect(refusals({ tarballPackage: undefined })).toContain("no package/package.json");
  });

  test("an unrecorded name is refused, listing what is recorded", () => {
    expect(refusals({ name: "nope" })).toContain("(recorded: app)");
  });

  test("refuses where it can't find exactly what to rewrite", () => {
    expect(refusals({ packageJson: JSON.stringify({ dependencies: { app: "1.0.0" } }) })).toContain(
      "doesn't depend on app as the recorded tarball vendor/app-1.0.0.tgz",
    );
    expect(refusals({ configText: `${CONFIG}// "vendor/app-1.0.0.tgz"\n` })).toContain("2 times");
    expect(refusals({ configText: CONFIG.replace(OLD, "x") })).toContain("nowhere");
  });

  test("the same tarball again is refused as already there", () => {
    expect(refusals({ file: "app-1.0.0.tgz", actual: OLD, expected: OLD })).toContain(
      "already at vendor/app-1.0.0.tgz",
    );
  });
});
