import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { loadConfig } from "../../src/adapters/config.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "mshape-config-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  test("a module the config imports that doesn't parse is named, with its line", async () => {
    // An adopter rule, imported and listed by the config, with a syntax error.
    await Bun.write(join(dir, "rules", "broken.ts"), "export default { a: ;\n");
    await Bun.write(
      join(dir, "shape.config.ts"),
      'import broken from "./rules/broken.ts";\nexport default { localRules: [broken] };\n',
    );
    const error = await Effect.runPromise(Effect.flip(loadConfig(dir)));
    expect(error.message).toContain(`${join(dir, "rules", "broken.ts")}:1:`);
    expect(error.message).toContain("Unexpected");
  });

  test("names the file it tried: --config's path, not shape.config.ts", async () => {
    const given = await Effect.runPromise(Effect.flip(loadConfig(dir, join(dir, "nope.ts"))));
    expect(given.message).toBe("nope.ts: not found");
    const own = await Effect.runPromise(Effect.flip(loadConfig(dir)));
    expect(own.message).toBe("shape.config.ts: not found; every adopting repo has one");
    const outside = await Effect.runPromise(Effect.flip(loadConfig(dir, "/nowhere/x.ts")));
    expect(outside.message).toBe("/nowhere/x.ts: not found");
  });
});
