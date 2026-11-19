/**
 * The loop's text for `mshape prime`: what `bd prime` prints (the repo's PRIME.md and bd's
 * memories), else the repo's `.beads/PRIME.md` itself, so a session without bd still loads
 * the loop. Never fails: prime runs at every session start.
 */
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import { PRIME_FILE } from "../core/conventions.ts";
import { runTool } from "./process.ts";

/** Where to install bd, for the note when it can't run. */
export const BEADS_URL = "https://github.com/steveyegge/beads";

/** The nearest `.beads/PRIME.md` from `cwd` up, or undefined. */
const primeFile = (cwd: string) =>
  Effect.promise(async () => {
    for (let dir = cwd; ; dir = dirname(dir)) {
      const file = Bun.file(join(dir, PRIME_FILE));
      if (await file.exists()) return file.text();
      if (dirname(dir) === dir) return undefined;
    }
  });

/** PRIME's text, and a note when bd couldn't give it. */
export const primeText = (cwd: string) =>
  Effect.gen(function* () {
    const bd = yield* runTool(cwd, ["bd", "prime"]);
    if (bd.code === 0 && bd.stdout.trim() !== "") return { text: bd.stdout.trimEnd() };
    const own = yield* primeFile(cwd);
    const why = `bd could not run here (${bd.code === -1 ? "not installed" : `exit ${bd.code}`})`;
    return own === undefined
      ? {
          note: `note: ${why}, and there is no ${PRIME_FILE}, so this session has no beads primer. Install bd: ${BEADS_URL}`,
        }
      : {
          text: own.trimEnd(),
          note: `note: ${why}, so this is ${PRIME_FILE} without bd's memories. Install bd: ${BEADS_URL}`,
        };
  });
