/**
 * Every harness this mshape ships, with its I/O built from the environment: one line per
 * adapter. Commands get them as one value, so a test swaps in its own.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Harness, HarnessIO } from "../../harnesses/harness.ts";
import { HARNESSES } from "../../harnesses/index.ts";
import { DEFAULT_HARNESSES } from "../../schemas/config.ts";
import { claudeCodeIO } from "./claude-code.ts";
import { codexIO } from "./codex.ts";

export interface Harnesses {
  readonly list: ReadonlyArray<Harness>;
  /** The I/O of the harness with this id, or undefined for one this mshape doesn't ship. */
  readonly io: (id: string) => HarnessIO | undefined;
}

export const harnesses = (env: Readonly<Record<string, string | undefined>>): Harnesses => {
  const ios: ReadonlyArray<HarnessIO> = [claudeCodeIO(env), codexIO(env)];
  return { list: HARNESSES, io: (id) => ios.find((io) => io.id === id) };
};

/**
 * The harnesses the nearest `shape.toml` from `cwd` lists, read on its own and leniently: who
 * runs a command is asked of these only, so a variable another harness leaked into this one
 * claims nothing. A `shape.toml` without the key lists the default. Undefined, so every shipped
 * harness is asked, when there is no `shape.toml` or it doesn't parse: `mshape prime` must work
 * before a config loads.
 */
export const listedHarnesses = (cwd: string): ReadonlyArray<string> | undefined => {
  for (let dir = cwd; ; dir = dirname(dir)) {
    let text: string | undefined;
    try {
      text = readFileSync(join(dir, "shape.toml"), "utf8");
    } catch {
      text = undefined;
    }
    if (text !== undefined) {
      try {
        const listed = (Bun.TOML.parse(text) as { harnesses?: unknown }).harnesses;
        if (listed === undefined) return DEFAULT_HARNESSES;
        return Array.isArray(listed) && listed.every((id) => typeof id === "string")
          ? (listed as ReadonlyArray<string>)
          : undefined;
      } catch {
        return undefined;
      }
    }
    if (dirname(dir) === dir) return undefined;
  }
};
