/**
 * Who runs a command: the harness a hook names, the hook's input, and what each harness this
 * mshape ships makes of them. The composition root's, beside `main.ts`.
 */
import { type Harnesses, harnesses } from "../adapters/harnesses/index.ts";
import type { Caller } from "../adapters/notices.ts";
import { identifySession } from "../core/notices.ts";
import type { Invocation } from "../harnesses/harness.ts";

/**
 * The harness a hook names (`mshape --harness <id> ...`), for this run: `program` sets it
 * from the leading flag before any command runs.
 */
let invokedBy: Invocation["harness"];

/** Sets the harness a hook named for this run; `program` calls it before any command. */
export const setInvokedBy = (harness: Invocation["harness"]): void => {
  invokedBy = harness;
};

/** The caller, as its harness tells it: `hookInput` is a hook's stdin, when there is one. */
const callerFrom = (hookInput?: string): Caller => {
  const shipped: Harnesses = harnesses(process.env);
  const found = identifySession(shipped.list, {
    env: process.env,
    ...(hookInput === undefined ? {} : { hookInput }),
    ...(invokedBy === undefined ? {} : { harness: invokedBy }),
  });
  return found.kind === "identified"
    ? { identity: found.identity, harnesses: shipped, now: new Date() }
    : { identity: undefined, unidentified: found.reason, harnesses: shipped, now: new Date() };
};

export const caller = (): Caller => callerFrom();

/**
 * How long a hook's input may take to arrive. A hook's stdin is written at once and closed;
 * anything slower isn't a hook's (a pipe left open), and is not waited on.
 */
const HOOK_INPUT_MS = 1000;

/**
 * A hook's stdin: never read from a terminal, where nothing would end it (`jhz.3`), and given
 * up after `HOOK_INPUT_MS`.
 */
const hookInput = (): Promise<string | undefined> =>
  new Promise((resolve) => {
    const { stdin } = process;
    if (stdin.isTTY === true) return resolve(undefined);
    const chunks: Array<Buffer> = [];
    const done = (input: string | undefined) => {
      clearTimeout(timer);
      // A pipe left open would keep the process alive after its output. Listeners stay:
      // removed first, Bun keeps the pipe open.
      stdin.destroy();
      resolve(input);
    };
    const timer = setTimeout(() => done(undefined), HOOK_INPUT_MS);
    stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    stdin.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    stdin.on("error", () => done(undefined));
  });

/** A hook's caller: identified from the hook's input when there is one, else as any caller. */
export const hookCaller = async (): Promise<Caller> => callerFrom(await hookInput());
