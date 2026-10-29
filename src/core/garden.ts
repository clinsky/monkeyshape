/** The numbers the milestone-boundary sweep reviews. Reporting only; `budgets` enforces caps. */
import type { ResolvedConfig } from "../schemas/config.ts";
import { measure } from "./budgets.ts";
import { isTsSource, type Snapshot } from "./model.ts";
import type { Counts } from "./ratchet.ts";
import type { GardenReport } from "./report.ts";

const occurrences = (text: string, pattern: RegExp): number => text.match(pattern)?.length ?? 0;

export const garden = (
  config: ResolvedConfig,
  snapshot: Snapshot,
  baseline: Counts,
): GardenReport => {
  let shapeIgnores = 0;
  let biomeIgnores = 0;
  for (const file of snapshot.files) {
    if (!isTsSource(file)) continue;
    const text = snapshot.texts.get(file) ?? "";
    shapeIgnores += occurrences(text, /^\s*\/\/\s*shape-ignore\s/gm);
    biomeIgnores += occurrences(text, /^\s*\/\/\s*biome-ignore/gm);
  }
  const allowances =
    Object.values(config.rules).reduce((sum, rule) => sum + (rule.allow?.length ?? 0), 0) +
    config.budgets.largeFiles.length;
  const ratcheted = Object.values(baseline)
    .flatMap((files) => Object.values(files))
    .reduce((sum, n) => sum + n, 0);
  return {
    metrics: measure(config, snapshot),
    budgets: {
      agentsLines: config.budgets.agentsLines,
      readmeLines: config.budgets.readmeLines,
      decisions: config.budgets.decisions,
      memories: config.budgets.memories,
      memoryBytes: config.budgets.memoryBytes,
    },
    escapeHatches: { shapeIgnores, biomeIgnores, allowances },
    ratcheted,
  };
};
