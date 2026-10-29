/** `.shape/baseline.json`: grandfathered violation counts per rule and file. */
import { Effect, Schema } from "effect";
import type { Counts } from "../core/ratchet.ts";
import { decodeStrict } from "../helpers/decodeStrict.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { readText } from "./workspace.ts";

export const BASELINE_FILE = ".shape/baseline.json";

const Baseline = Schema.Struct({
  version: Schema.Literal(1),
  counts: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Int)),
});

export const readBaseline = (root: string) =>
  Effect.gen(function* () {
    if (!(yield* Effect.promise(() => Bun.file(`${root}/${BASELINE_FILE}`).exists())))
      return {} as Counts;
    const text = yield* readText(root, BASELINE_FILE);
    const json = yield* Effect.try({
      try: (): unknown => JSON.parse(text),
      catch: () =>
        new WorkspaceError({ operation: "parse", path: BASELINE_FILE, reason: "not valid JSON" }),
    });
    const baseline = yield* decodeStrict(Baseline)(json).pipe(
      Effect.mapError(
        (error) =>
          new WorkspaceError({ operation: "decode", path: BASELINE_FILE, reason: error.message }),
      ),
    );
    return baseline.counts;
  });

const sorted = (counts: Counts): Counts =>
  Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((rule) => [
        rule,
        Object.fromEntries(
          Object.entries(counts[rule] ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]),
  );

export const writeBaseline = (root: string, counts: Counts) =>
  Effect.tryPromise({
    try: () =>
      Bun.write(
        `${root}/${BASELINE_FILE}`,
        `${JSON.stringify({ version: 1, counts: sorted(counts) }, null, 2)}\n`,
      ),
    catch: (cause) =>
      new WorkspaceError({ operation: "write", path: BASELINE_FILE, reason: String(cause) }),
  });
