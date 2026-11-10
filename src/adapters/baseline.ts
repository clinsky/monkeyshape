/** `.shape/baseline.json`: grandfathered violation counts per rule and file. */
import { Effect, Schema } from "effect";
import type { ChangedLines } from "../core/model.ts";
import { type Counts, parseChangedLines } from "../core/ratchet.ts";
import { decodeStrict } from "../helpers/decodeStrict.ts";
import { WorkspaceError } from "../schemas/errors.ts";
import { run } from "./process.ts";
import { mergeTargets } from "./tracks.ts";
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

/**
 * The lines this branch changed since its merge base with `main` (its upstream when there is
 * one): committed, staged or not, and untracked files whole. Undefined where there is no
 * merge base, such as a fresh repo or a shallow CI checkout: the ratchet then lists every
 * occurrence over a baseline, as it can't tell the new one.
 */
export const readChangedLines = (root: string) =>
  Effect.gen(function* () {
    const targets = yield* mergeTargets(root);
    const target = targets[targets.length - 1];
    if (target === undefined) return undefined;
    const base = yield* run(root, ["git", "merge-base", "HEAD", target]);
    if (base.code !== 0) return undefined;
    const diff = yield* run(root, [
      "git",
      "-c",
      "core.quotePath=false",
      "diff",
      "-U0",
      "--no-color",
      "--no-ext-diff",
      "-M",
      base.stdout.trim(),
    ]);
    if (diff.code !== 0) return undefined;
    const untracked = yield* run(root, [
      "git",
      "-c",
      "core.quotePath=false",
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const changed = new Map(parseChangedLines(diff.stdout));
    if (untracked.code === 0)
      for (const file of untracked.stdout.split("\n")) if (file !== "") changed.set(file, "all");
    return changed satisfies ChangedLines;
  }).pipe(
    // Without git's answer the ratchet lists every occurrence, as it did before it could tell.
    Effect.orElseSucceed(() => undefined),
  );
