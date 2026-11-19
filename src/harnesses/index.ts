/** Every harness this mshape ships: one line per adapter. */
import { claudeCode } from "./claude-code/index.ts";
import type { Harness } from "./harness.ts";

export const HARNESSES: ReadonlyArray<Harness> = [claudeCode];
