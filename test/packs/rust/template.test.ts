/**
 * The Rust pack's init template, `template/packs/rust/`: laid over the shared `template/` by
 * `mshape init <name> --pack rust`. A born Rust repo needs no Bun: its gate is cargo's
 * stages and `mshape check`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CURATED } from "../../../src/packs/rust/lints.ts";
import { initFromSource, ROOT, run } from "../../integration/harness.ts";
import { skipWithout } from "../../support.ts";

const TEMPLATE = join(ROOT, "template", "packs", "rust");
const read = (path: string) => Bun.file(join(TEMPLATE, path)).text();

const filesUnder = async (directory: string): Promise<ReadonlyArray<string>> =>
  (await readdir(directory, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

describe("template/packs/rust", () => {
  test("the starter crate opts into the workspace lints, and the toolchain brings clippy and rustfmt", async () => {
    expect(Bun.TOML.parse(await read("crates/{{module}}/Cargo.toml"))).toMatchObject({
      lints: { workspace: true },
    });
    expect(Bun.TOML.parse(await read("rust-toolchain.toml"))).toMatchObject({
      toolchain: { components: ["clippy", "rustfmt"] },
    });
  });

  test("gitignore is the shared one, plus cargo's target/", async () => {
    const shared = await Bun.file(join(ROOT, "template", "gitignore")).text();
    const own = await read("gitignore");
    expect(own.startsWith(shared)).toBe(true);
    expect(own.slice(shared.length)).toContain("\n/target\n");
  });

  test("AGENTS.md keeps the shared one's sections, in order", async () => {
    const headings = (text: string) => text.split("\n").filter((line) => line.startsWith("## "));
    const shared = await Bun.file(join(ROOT, "template", "AGENTS.md")).text();
    expect(headings(await read("AGENTS.md"))).toEqual(headings(shared));
  });

  test("no file runs Bun or installs from npm: a born Rust repo needs neither", async () => {
    const runsBun =
      /\bbunx?\s+(run|install|test|add|x)\b|setup-bun|package\.json|node_modules\/\.bin/;
    const named: Array<string> = [];
    for (const file of await filesUnder(TEMPLATE))
      if (runsBun.test(await Bun.file(file).text())) named.push(file);
    expect(named).toEqual([]);
  });
});

// init needs no cargo: what it writes is checked wherever the tests run.
describe("mshape init my-repo --pack rust", () => {
  let work = "";
  const born = () => join(work, "my-repo");

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "rust-born-"));
    const created = await initFromSource(work, ["my-repo", "--pack", "rust"], {
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_PID: "",
      CODEX_THREAD_ID: "",
    });
    expect(created.code).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  // The sync check holds the born repo to these tables from its first gate.
  test("Cargo.toml has the workspace lints, delivered by init as sync would", async () => {
    const cargo = Bun.TOML.parse(await Bun.file(join(born(), "Cargo.toml")).text());
    expect(cargo).toMatchObject({ workspace: { lints: CURATED, members: ["crates/*"] } });
  });

  test("the starter crate is named for the repo, as a crate and as a module", async () => {
    const crate = Bun.TOML.parse(await Bun.file(join(born(), "crates/my_repo/Cargo.toml")).text());
    expect(crate).toMatchObject({ package: { name: "my-repo" }, lints: { workspace: true } });
    const shape = Bun.TOML.parse(await Bun.file(join(born(), "shape.toml")).text());
    expect(shape).toMatchObject({ arch: { modules: { my_repo: { paths: ["crates/my_repo"] } } } });
  });
});

// The bead's acceptance on a real toolchain: born, then the gate with Bun off the PATH.
const cargo = Bun.which("cargo");
const toolchain = cargo !== null && Bun.spawnSync([cargo, "clippy", "--version"]).exitCode === 0;
/** Skipped without the toolchain, except in CI, where it fails instead. */
const noToolchain = skipWithout(toolchain);

describe.skipIf(noToolchain)("mshape init --pack rust, then its gate without Bun", () => {
  let work = "";
  let born = "";
  const NO_SESSION = { CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "", CODEX_THREAD_ID: "" };
  // cargo's own directory and the system's: bun lives in neither.
  const PATH = [dirname(cargo ?? ""), "/usr/bin", "/bin"].join(":");
  const mshape = (args: ReadonlyArray<string>) =>
    run(born, [process.execPath, join(ROOT, "src", "cli", "main.ts"), ...args], {
      ...NO_SESSION,
      PATH,
    });

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "rust-template-"));
    born = join(work, "born");
    const created = await initFromSource(work, ["born", "--pack", "rust"], NO_SESSION);
    expect(created.code).toBe(0);
  }, 120_000);

  afterAll(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test("the born repo has no package.json or node_modules", async () => {
    const tracked = (await run(born, ["git", "ls-files"])).output.split("\n");
    expect(tracked).not.toContain("package.json");
    expect(tracked.some((file) => file.startsWith("node_modules/"))).toBe(false);
    expect(tracked).toContain("Cargo.toml");
  });

  // 8il.15's acceptance: the born repo is green on its first gate, with no Bun anywhere.
  test("the whole gate passes on the first run: cargo's stages and mshape check", async () => {
    const gate = await mshape(["gate"]);
    for (const stage of ["cargo-fmt", "clippy", "mshape-check", "cargo-test"])
      expect(gate.output).toMatch(new RegExp(`\\n\\s+${stage}\\s+passed`));
    expect(gate.output).toContain("mshape gate passed");
    expect(gate.code).toBe(0);
  }, 300_000);
});
