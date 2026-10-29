/**
 * An adopter's first hour, for real: pack this package, install the tarball into a fresh git
 * repo built from the README's own code blocks, and drive the installed `mshape` binary
 * through the gate, a regression, a fix, the ratchet, `--only`, and beads without `bd`.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../../package.json" with { type: "json" };

const ROOT = join(import.meta.dir, "..", "..");

const readmeBlocks = async (): Promise<ReadonlyArray<string>> => {
  const readme = await Bun.file(join(ROOT, "README.md")).text();
  return [...readme.matchAll(/```\w*\n([\s\S]*?)```/g)].map((block) => block[1] ?? "");
};

/** `// <file>` or `<!-- <file> -->` on the first line of a README code block names the file. */
const readmeFiles = async (): Promise<Record<string, string>> => {
  const files: Record<string, string> = {};
  for (const block of await readmeBlocks()) {
    const [first = "", ...rest] = block.split("\n");
    const name = /^(?:\/\/|<!--)\s*([\w.-]+\.\w+)\s*(?:-->)?$/.exec(first.trim())?.[1];
    if (name !== undefined) files[name] = rest.join("\n");
  }
  return files;
};

let repo = "";
let bin = "";

const run = async (command: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const child = Bun.spawn([...command], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  return { code: await child.exited, output: `${stdout}${stderr}` };
};

const mshape = (args: ReadonlyArray<string>, env: Record<string, string> = {}) =>
  run([join(repo, "node_modules", ".bin", "mshape"), ...args], env);

const write = async (path: string, text: string) => {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), text);
};

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "mshape-consumer-"));
  bin = await mkdtemp(join(tmpdir(), "mshape-bin-"));
  const packed = await Bun.$`bun pm pack --destination ${bin} --quiet`.cwd(ROOT).text();
  const tarball = join(bin, packed.trim().split("\n").at(-1)?.split("/").at(-1) ?? "");

  const dev = pkg.devDependencies;
  await write(
    "package.json",
    `${JSON.stringify(
      {
        name: "consumer",
        private: true,
        type: "module",
        devDependencies: {
          monkeyshape: `file:${tarball}`,
          effect: dev.effect,
          "@biomejs/biome": dev["@biomejs/biome"],
          typescript: dev.typescript,
          "@types/bun": dev["@types/bun"],
        },
      },
      null,
      2,
    )}\n`,
  );
  for (const [path, text] of Object.entries(await readmeFiles())) await write(path, text);
  await write(".gitignore", "node_modules/\n");
  await write(
    "src/core/greet.ts",
    "export const greet = (name: string): string => name.toUpperCase();\n",
  );
  expect((await run(["git", "init", "-q"])).code).toBe(0);
  const install = await run([process.execPath, "install"]);
  expect(install.output).not.toContain("error:");
  expect(install.code).toBe(0);
}, 120_000);

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
  await rm(bin, { recursive: true, force: true });
});

describe("an adopter following the README", () => {
  test("the README files carry everything the gate needs", async () => {
    expect(Object.keys(await readmeFiles()).sort()).toEqual([
      "AGENTS.md",
      "biome.json",
      "shape.config.ts",
      "tsconfig.json",
    ]);
  });

  test("tsc and biome accept the README configs, extends and all", async () => {
    const tsc = await run([process.execPath, "node_modules/.bin/tsc", "-p", "."]);
    expect(tsc.output).toBe("");
    const biome = await run([
      process.execPath,
      "node_modules/.bin/biome",
      "ci",
      "--error-on-warnings",
      ".",
    ]);
    expect(biome.code).toBe(0);
  });

  test("the installed binary passes a clean repo, asking tsc and biome rather than guessing", async () => {
    const result = await mshape(["check"]);
    expect(result.output).toContain("mshape check passed");
    expect(result.output).not.toContain("note:");
    expect(result.code).toBe(0);
  });

  test("the README's example output is what the installed binary prints", async () => {
    await write("src/core/cache.ts", "export const stamp = (): number => Date.now();\n");
    await write(
      "src/core/client.ts",
      'import { readFile } from "node:fs/promises";\n\nexport const load = (path: string) => readFile(path, "utf8");\n',
    );
    let actual = { code: 0, output: "" };
    try {
      actual = await mshape(["check"]);
    } finally {
      await rm(join(repo, "src/core/cache.ts"));
      await rm(join(repo, "src/core/client.ts"));
    }
    const example = (await readmeBlocks()).find((block) => block.startsWith("$ mshape check\n"));
    expect(`$ mshape check\n${actual.output}`).toBe(example ?? "(no example block in README)");
    expect(actual.code).toBe(1);
  });

  test("new violations fail; the ratchet grandfathers, then holds", async () => {
    await write(
      "src/core/legacy.ts",
      "export const stamp = () => Date.now();\nexport const boom = () => {\n  throw new Error('x');\n};\n",
    );
    const failing = await mshape(["check"]);
    expect(failing.code).toBe(1);
    expect(failing.output).toContain("rules/no-throw");
    expect(failing.output).toContain("rules/no-nondeterminism");

    expect((await mshape(["baseline", "--init"])).code).toBe(0);
    expect((await mshape(["check"])).output).toContain("2 grandfathered");

    await write("src/core/legacy.ts", "export const boom = () => {\n  throw new Error('x');\n};\n");
    const loose = await mshape(["check"]);
    expect(loose.code).toBe(1);
    expect(loose.output).toContain("ratchet is loose");

    expect((await mshape(["baseline", "--tighten"])).code).toBe(0);
    expect((await mshape(["check"])).code).toBe(0);
  });

  test("--only ignores baseline entries for checks it didn't run", async () => {
    const result = await mshape(["check", "--only", "refs"]);
    expect(result.output).not.toContain("loose");
    expect(result.code).toBe(0);
  });

  test("beads without bd: optional says what it skipped, required fails closed", async () => {
    await write(".beads/config.yaml", "issue-prefix: consumer\n");
    // A PATH with bun and git but no bd, as on a CI runner.
    const path = await mkdtemp(join(tmpdir(), "mshape-path-"));
    await symlink(process.execPath, join(path, "bun"));
    await symlink(Bun.which("git") ?? "/usr/bin/git", join(path, "git"));
    const env = { PATH: path };

    const optional = await mshape(["check"], env);
    expect(optional.output).toContain("note: skipped refs/bead-in-code");
    expect(optional.output).toContain("bd is not on PATH");
    expect(optional.code).toBe(0);

    const config = await Bun.file(join(repo, "shape.config.ts")).text();
    await write(
      "shape.config.ts",
      config.replace(
        "export default defineConfig({",
        'export default defineConfig({\n  beads: "required",',
      ),
    );
    const required = await mshape(["check"], env);
    expect(required.output).toContain("prerequisites/beads-required");
    expect(required.code).toBe(1);

    // Neither a baseline nor --only can make a required integration optional.
    const init = await mshape(["baseline", "--init"], env);
    expect(init.output).toContain("not written, because a prerequisite fails");
    expect(init.code).toBe(1);
    const tighten = await mshape(["baseline", "--tighten"], env);
    expect(tighten.code).toBe(1);
    const onlyRefs = await mshape(["check", "--only", "refs"], env);
    expect(onlyRefs.output).toContain("prerequisites/beads-required");
    expect(onlyRefs.code).toBe(1);
    await rm(path, { recursive: true, force: true });
  });
});
