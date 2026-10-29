#!/usr/bin/env bun
/** The `mshape` executable: the composition root, and the only place effects are run. */
import { Effect } from "effect";
import pkg from "../../package.json" with { type: "json" };
import { BASELINE_FILE, readBaseline, writeBaseline } from "../adapters/baseline.ts";
import { loadConfig } from "../adapters/config.ts";
import { loadSnapshot } from "../adapters/workspace.ts";
import { CHECKS, runChecks, unevaluated } from "../core/check.ts";
import { garden } from "../core/garden.ts";
import type { CheckName } from "../core/model.ts";
import { applyBaseline, count, tighten } from "../core/ratchet.ts";
import { formatCheck, formatGarden } from "../core/report.ts";
import { RULES } from "../core/rules/registry.ts";

const USAGE = `mshape ${pkg.version}

  mshape check [--only arch,refs,budgets,coverage,rules]
      Run the checks; violations above .shape/baseline.json fail.
  mshape baseline --tighten
      Lower baseline counts to what is found now. Never raises one.
  mshape baseline --init
      Grandfather every current violation. For adopting a repo; review the diff.
  mshape garden
      Print budgets and escape hatches for the milestone-boundary sweep.
  mshape rules
      List the custom rules and the bug class each one removes.

  --config <path>   Use this config instead of ./shape.config.ts (trying a repo before adopting).`;

const parseOnly = (args: ReadonlyArray<string>): ReadonlyArray<CheckName> | string => {
  const index = args.indexOf("--only");
  if (index === -1) return CHECKS;
  const names = (args[index + 1] ?? "").split(",").filter(Boolean);
  const unknown = names.filter((name) => !(CHECKS as ReadonlyArray<string>).includes(name));
  return unknown.length > 0 || names.length === 0
    ? `unknown check(s): ${unknown.join(", ") || "(none given)"}`
    : (names as ReadonlyArray<CheckName>);
};

const program = (root: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const [command, ...rest] = args;
    if (command === "--version") return { output: pkg.version, code: 0 };
    if (command === "rules")
      return {
        output: RULES.map((r) => `${r.id.padEnd(22)}${r.layer.padEnd(9)}${r.bugClass}`).join("\n"),
        code: 0,
      };
    if (command !== "check" && command !== "baseline" && command !== "garden")
      return {
        output: USAGE,
        code: command === undefined || command === "help" || command === "--help" ? 0 : 2,
      };

    const configFlag = rest.indexOf("--config");
    const configPath = configFlag === -1 ? undefined : rest[configFlag + 1];
    const config = yield* loadConfig(
      root,
      configPath === undefined
        ? undefined
        : configPath.startsWith("/")
          ? configPath
          : `${root}/${configPath}`,
    );
    const snapshot = yield* loadSnapshot(root, config);
    const baseline = yield* readBaseline(root);

    if (command === "garden")
      return { output: formatGarden(garden(config, snapshot, baseline)), code: 0 };

    if (command === "baseline") {
      const violations = runChecks(config, snapshot);
      if (rest.includes("--init")) {
        yield* writeBaseline(root, count(violations));
        return {
          output: `${BASELINE_FILE}: grandfathered ${violations.length} violation(s)`,
          code: 0,
        };
      }
      if (rest.includes("--tighten")) {
        yield* writeBaseline(root, tighten(baseline, violations, unevaluated(snapshot)));
        return { output: `${BASELINE_FILE}: tightened`, code: 0 };
      }
      return { output: USAGE, code: 2 };
    }

    const only = parseOnly(rest);
    if (typeof only === "string") return { output: only, code: 2 };
    const result = applyBaseline(
      runChecks(config, snapshot, only),
      baseline,
      unevaluated(snapshot),
    );
    return {
      output: formatCheck(result),
      code: result.failing.length + result.loose.length > 0 ? 1 : 0,
    };
  });

const outcome = await Effect.runPromise(
  program(process.cwd(), process.argv.slice(2)).pipe(
    Effect.catchTags({
      ConfigError: (error) => Effect.succeed({ output: `mshape: ${error.message}`, code: 2 }),
      WorkspaceError: (error) => Effect.succeed({ output: `mshape: ${error.message}`, code: 2 }),
    }),
  ),
);
if (outcome.code === 0) console.log(outcome.output);
else console.error(outcome.output);
process.exitCode = outcome.code;
