import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { COMMANDS, help } from "../../src/cli/main.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "main.ts");

const mshape = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn([process.execPath, CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = [
    await new Response(child.stdout).text(),
    await new Response(child.stderr).text(),
  ];
  return { stdout, stderr, code: await child.exited };
};

describe("the command table", () => {
  test("help lists every command in the table, each with its usage", () => {
    const text = help();
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const command of COMMANDS) {
      expect(command.usage).toStartWith(`  mshape ${command.name}`);
      expect(text).toContain(command.usage);
    }
  });

  test("an unknown command says so on stderr before the help, and exits 2", async () => {
    const result = await mshape(["frobnicate"]);
    expect(result.stderr).toBe(`mshape: unknown command 'frobnicate'\n\n${help()}\n`);
    expect(result.stdout).toBe("");
    expect(result.code).toBe(2);
  });

  test("help, --help and no command print the help to stdout and exit 0", async () => {
    for (const args of [[], ["help"], ["--help"]]) {
      const result = await mshape(args);
      expect(result.stdout).toBe(`${help()}\n`);
      expect(result.code).toBe(0);
    }
  });

  test("a known command with a bad subcommand prints the help alone and exits 2", async () => {
    const result = await mshape(["skills", "frobnicate"]);
    expect(result.stderr).toBe(`${help()}\n`);
    expect(result.code).toBe(2);
  });
});
