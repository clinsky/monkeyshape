import { describe, expect, test } from "bun:test";
import { nextStep, REPO_NAME, scaffold, targetPath } from "../../src/core/scaffold.ts";

const toolchain = {
  bun: "1.4.2",
  monkeyshape: "0.2.0",
  effect: "4.0.0",
  biome: "2.5.15",
  typescript: "7.0.2",
  typesBun: "1.4.2",
};

describe("scaffold", () => {
  test("renders the name into template files and restores the dot npm strips", () => {
    const files = scaffold(
      "my-app",
      new Map([
        ["AGENTS.md", "# {{name}}\n"],
        ["gitignore", "node_modules/\n"],
      ]),
      toolchain,
    );
    expect(files.get("AGENTS.md")).toBe("# my-app\n");
    expect(files.get(".gitignore")).toBe("node_modules/\n");
    expect(files.has("gitignore")).toBe(false);
    expect(targetPath(".claude/settings.json")).toBe(".claude/settings.json");
  });

  test("package.json pins the toolchain exactly, and its gate passes with no tests yet", () => {
    const manifest = JSON.parse(scaffold("my-app", new Map(), toolchain).get("package.json") ?? "");
    expect(manifest.name).toBe("my-app");
    expect(manifest.packageManager).toBe("bun@1.4.2");
    expect(manifest.dependencies).toEqual({ effect: "4.0.0" });
    expect(manifest.devDependencies).toEqual({
      "@biomejs/biome": "2.5.15",
      "@types/bun": "1.4.2",
      monkeyshape: "0.2.0",
      typescript: "7.0.2",
    });
    expect(manifest.scripts.check).toContain("bun test --pass-with-no-tests");
  });

  test("tsconfig and biome cover shape.config.ts, so coverage holds from the first commit", () => {
    const files = scaffold("my-app", new Map(), toolchain);
    expect(JSON.parse(files.get("tsconfig.json") ?? "").include).toContain("*.ts");
    expect(JSON.parse(files.get("biome.json") ?? "").files.includes).toContain("*.ts");
  });

  test("generated configs win over a template file of the same name", () => {
    const files = scaffold("my-app", new Map([["package.json", "{}"]]), toolchain);
    expect(files.get("package.json")).not.toBe("{}");
  });

  test("a repo name is lowercase words joined by hyphens", () => {
    for (const good of ["app", "my-app", "app2"]) expect(REPO_NAME.test(good)).toBe(true);
    for (const bad of ["My-App", "-app", "app-", "my_app", "../app", "a b", ""])
      expect(REPO_NAME.test(bad)).toBe(false);
  });

  test("the next step names /roadmap and the workflow doc", () => {
    const text = nextStep("my-app", "https://example.com/docs/workflow.md");
    expect(text).toContain("/roadmap");
    expect(text).toContain("my-app/");
    expect(text).toContain("https://example.com/docs/workflow.md");
  });
});
