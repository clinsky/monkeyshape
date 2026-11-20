import { describe, expect, test } from "bun:test";
import {
  invocation,
  nextStep,
  PACKS_DIR,
  pinTable,
  REPO_NAME,
  recordHarnesses,
  recordPin,
  render,
  SHARE_BEADS,
  scaffold,
  targetPath,
  templateFor,
} from "../../src/core/scaffold.ts";
import { HARNESSES } from "../../src/harnesses/index.ts";
import { PACKS } from "../../src/packs/index.ts";

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
    expect(targetPath("bunfig")).toBe("bunfig.toml");
    expect(targetPath(".claude/settings.json")).toBe(".claude/settings.json");
  });

  test("renders {{module}}, the name as an identifier, in text and in paths", () => {
    const files = scaffold(
      "my-app",
      new Map([["src/{{module}}/__init__.py", '"""{{name}}, imported as {{module}}."""\n']]),
      toolchain,
      undefined,
      "python",
    );
    expect(files.get("src/my_app/__init__.py")).toBe('"""my-app, imported as my_app."""\n');
    expect([...files.keys()].some((path) => path.includes("{{"))).toBe(false);
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
    // The typescript pack's test stage passes with no tests: test/core/gate.test.ts.
    expect(manifest.scripts.check).toBe("mshape gate");
  });

  test("tsconfig and biome cover TypeScript at the root, so coverage holds from the first commit", () => {
    const files = scaffold("my-app", new Map(), toolchain);
    expect(JSON.parse(files.get("tsconfig.json") ?? "").include).toContain("*.ts");
    expect(JSON.parse(files.get("biome.json") ?? "").files.includes).toContain("*.ts");
  });

  test("shape.toml gets the pin before its first table, and the vendored record after all", () => {
    const template = new Map([
      [
        "shape.toml",
        'packs = ["typescript"]\n\n# Modules.\n[arch.modules.core]\noptional = true\n',
      ],
    ]);
    const entry = { path: "vendor/m.tgz", package: "monkeyshape", sha256: "a".repeat(64) };
    const pin = { version: "1.2.3", sums: "b".repeat(64) };
    const text = scaffold("my-app", template, toolchain, entry, "typescript", pin).get(
      "shape.toml",
    );
    expect(Bun.TOML.parse(text ?? "")).toEqual({
      packs: ["typescript"],
      mshape: pin,
      arch: { modules: { core: { optional: true } } },
      files: { vendored: [entry] },
    });
    expect(text?.indexOf("[mshape]")).toBeLessThan(text?.indexOf("# Modules.") ?? 0);
  });

  test("a skill is named as each listed harness starts it, in init's closing steps", () => {
    const pick = (...ids: ReadonlyArray<string>) =>
      HARNESSES.filter((harness) => ids.includes(harness.id));
    expect(invocation(pick("claude-code"), "roadmap")).toBe("`/roadmap`");
    expect(invocation(pick("codex"), "roadmap")).toBe("`$roadmap`");
    expect(invocation(pick("claude-code", "codex"), "track", "docs")).toBe(
      "`/track docs` in Claude Code, `$track docs` in Codex",
    );
    expect(nextStep("app", "https://x", pick("codex"))).toContain("(`$roadmap`)");
    expect(nextStep("app", "https://x", pick("codex"))).not.toContain("`/roadmap`");
  });

  test("harnesses other than the default are recorded after packs; the default is left unsaid", () => {
    // Only ids matter here, and codex's adapter is its own track's: stand-ins by id.
    const [claude] = HARNESSES;
    const pick = (...ids: ReadonlyArray<"claude-code" | "codex">) =>
      ids.flatMap((id) => (claude === undefined ? [] : [{ ...claude, id }]));
    const config = 'packs = ["rust"]\n\n[arch.modules.core]\noptional = true\n';
    expect(recordHarnesses(config, pick("claude-code"))).toBe(config);
    const codex = recordHarnesses(config, pick("codex"));
    expect(Bun.TOML.parse(codex)).toEqual({
      packs: ["rust"],
      harnesses: ["codex"],
      arch: { modules: { core: { optional: true } } },
    });
    expect(codex.indexOf("harnesses")).toBeLessThan(codex.indexOf("[arch"));
  });

  test("a pin without sums writes none, and a config with no table gets it at the end", () => {
    const text = recordPin('packs = ["rust"]\n', { version: "1.2.3-dev.abc1234" });
    expect(Bun.TOML.parse(text)).toEqual({
      packs: ["rust"],
      mshape: { version: "1.2.3-dev.abc1234" },
    });
    expect(pinTable({ version: "1.2.3" })).not.toContain("sums");
  });

  test("every shipped template's shape.toml, rendered, takes a pin and stays valid TOML", async () => {
    const glob = new Bun.Glob("template/packs/*/shape.toml");
    const found = [];
    for await (const path of glob.scan(".")) {
      // As init writes it: {{name}} and {{module}} filled in (a module key may hold one).
      const rendered = render(await Bun.file(path).text(), "my-app");
      const text = recordPin(rendered, { version: "1.2.3" });
      expect(Bun.TOML.parse(text)).toMatchObject({ mshape: { version: "1.2.3" } });
      found.push(path);
    }
    expect(found).toContain("template/packs/typescript/shape.toml");
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
    // Agents push and open PRs from the first /roadmap: a remote comes first, and init never
    // creates one itself (it is public beyond a PR).
    expect(text).toContain("gh repo create my-app --private --source . --push");
    expect(text.indexOf("gh repo create")).toBeLessThan(text.indexOf("/roadmap"));
    // Then the beads, so a second clone can bootstrap them; printed, since it publishes them.
    expect(text).toContain(SHARE_BEADS);
    expect(text.indexOf("gh repo create")).toBeLessThan(text.indexOf(SHARE_BEADS));
  });
});

describe("a pack's template over the common one", () => {
  const tree = new Map([
    ["AGENTS.md", "# {{name}}\n"],
    ["gitignore", "node_modules\n"],
    ["packs/typescript/bunfig", "[test]\n"],
    ["packs/typescript/AGENTS.md", "# {{name}}, in TypeScript\n"],
    ["packs/rust/Cargo.toml", "[workspace]\n"],
  ]);

  test("the pack's files are laid over the rest, winning a path both have; other packs' are left out", () => {
    expect(templateFor(tree, "rust")).toEqual(
      new Map([
        ["AGENTS.md", "# {{name}}\n"],
        ["gitignore", "node_modules\n"],
        ["Cargo.toml", "[workspace]\n"],
      ]),
    );
    expect(templateFor(tree, "typescript")?.get("AGENTS.md")).toBe("# {{name}}, in TypeScript\n");
    expect(templateFor(tree, "python")).toBeUndefined();
  });

  test("only a TypeScript repo gets package.json, tsconfig and biome; every repo gets the hooks and PR template", () => {
    const toolchain = {
      bun: "1",
      monkeyshape: "1",
      effect: "1",
      biome: "1",
      typescript: "1",
      typesBun: "1",
    };
    const rust = scaffold(
      "app",
      templateFor(tree, "rust") ?? new Map(),
      toolchain,
      undefined,
      "rust",
      undefined,
      HARNESSES.filter((harness) => harness.id === "claude-code"),
    );
    expect([...rust.keys()].sort()).toEqual([
      ".claude/settings.json",
      ".github/pull_request_template.md",
      ".gitignore",
      "AGENTS.md",
      "Cargo.toml",
    ]);
    const ts = scaffold("app", templateFor(tree, "typescript") ?? new Map(), toolchain);
    expect([...ts.keys()]).toContain("package.json");
    expect([...ts.keys()]).toContain("bunfig.toml");
    expect(ts.get("AGENTS.md")).toBe("# app, in TypeScript\n");
  });
});

test("every shipped pack's template is where init looks for it: template/packs/<id>", () => {
  // init composes by id (templateFor); Pack.template must say the same, or the two drift.
  for (const pack of Object.values(PACKS))
    expect(pack?.template).toBe(`template/${PACKS_DIR}/${pack?.id}`);
});
