/** The TypeScript pack: oxc for the graph, comments and rules; tsc and biome for coverage. */
import { Visitor } from "oxc-parser";
import { TS_SOURCE } from "../../core/model.ts";
import { parse } from "../../core/parse.ts";
import { dirname, join } from "../../core/paths.ts";
import type { Finding, Rule } from "../../core/rules/engine.ts";
import { RULES } from "../../core/rules/registry.ts";
import { isDeclaration, isTest } from "../../core/sources.ts";
import type { Pack, PackRule } from "../pack.ts";
import { graph } from "./graph.ts";
import { biome, tsc } from "./tools.ts";

/** A registry rule over oxc's tree, run on text: relative imports resolve against `files`. */
export const onText = (rule: Rule): PackRule => ({
  id: rule.id,
  layer: rule.layer,
  bugClass: rule.bugClass,
  message: rule.message,
  entryExempt: rule.entryExempt,
  run: (file, files) => {
    const parsed = parse(file.path, file.text);
    if (rule.run !== undefined) {
      const found = rule.run(parsed);
      return "broken" in found ? [] : found;
    }
    const findings: Array<Finding> = [];
    const resolve = (specifier: string) => {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
      const target = join(dirname(file.path), specifier);
      const text = target.startsWith("..") ? undefined : files.get(target);
      return text === undefined ? undefined : parse(target, text);
    };
    new Visitor(rule.visit(parsed, (finding) => findings.push(finding), { resolve })).visit(
      parsed.program,
    );
    return findings;
  },
});

export const typescript: Pack = {
  id: "typescript",
  language: "TypeScript",
  kindOf: (file) =>
    !TS_SOURCE.test(file)
      ? undefined
      : isDeclaration(file)
        ? "declaration"
        : isTest(file)
          ? "test"
          : "source",
  comments: (file) =>
    parse(file.path, file.text).comments.map((comment) => ({
      kind: comment.type === "Line" ? "line" : "block",
      text: comment.value,
      start: comment.start,
      end: comment.end,
    })),
  syntaxErrors: (file) => parse(file.path, file.text).syntaxErrors,
  defaultSources: { include: ["src/**/*.{ts,tsx}", "tools/**/*.{ts,tsx}"] },
  hostSpecifiers: ["bun", "bun:*", "node:*", "@effect/platform-*"],
  graph,
  tools: [tsc, biome],
  findings: () => [],
  findingKinds: [],
  rules: RULES.map(onText),
  baseConfigs: [
    {
      delivery: "extends",
      shipped: "config/tsconfig.base.json",
      pointer: { file: "tsconfig.json", key: "extends" },
    },
    {
      delivery: "extends",
      shipped: "config/biome.base.json",
      pointer: { file: "biome.json", key: "extends" },
    },
  ],
  template: "template/packs/typescript",
  stages: [
    // Named for their tool: a repo stage replaces a pack's by name, so names are unique
    // across packs (`mshape gate`'s table).
    { name: "tsc", run: ["tsc", "-p", "."], fast: true },
    { name: "biome", run: ["biome", "ci", "--error-on-warnings", "."], fast: true },
    { name: "bun-test", run: ["bun", "test", "--pass-with-no-tests"] },
  ],
  prerequisites: [
    { name: "tsc", required: true, install: "`bun add -d typescript`" },
    { name: "biome", required: true, install: "`bun add -d @biomejs/biome`" },
  ],
  loadFor: ["coverage"],
};
