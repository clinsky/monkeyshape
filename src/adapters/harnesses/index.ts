/**
 * Every harness this mshape ships, with its I/O built from the environment: one line per
 * adapter. Commands get them as one value, so a test swaps in its own.
 */
import type { Harness, HarnessIO } from "../../harnesses/harness.ts";
import { HARNESSES } from "../../harnesses/index.ts";
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
