/**
 * Structured data must parse, with Bun's own parsers: a workflow, a manifest or a config that
 * doesn't parse fails where it's used, often in CI, often silently. Parsing is the whole
 * check: no schema validation of what the data says (a non-goal).
 */
import { matchesPathOrBelow } from "./glob.ts";

/**
 * JSON files whose tools read them as JSONC, by convention: TypeScript's, biome's and the
 * editor's configs, the dev container's (in `.devcontainer/` or as a root file), and the
 * common tool configs documented to take comments. Anything else named `.json` is strict
 * JSON, which every reader accepts; one whose tool fixes its name and reads comments is
 * exempt with that reason (the message says so).
 */
const JSONC_NAMES = [
  "tsconfig*.json",
  "jsconfig*.json",
  "biome*.json",
  ".devcontainer.json",
  "turbo.json",
  ".eslintrc.json",
  "deno.json",
  "cspell.json",
  "api-extractor.json",
];
const JSONC_DIRECTORIES = [".vscode", ".devcontainer"];
const JSONC_BY_CONVENTION = [
  ...JSONC_NAMES.flatMap((name) => [name, `**/${name}`]),
  ...JSONC_DIRECTORIES.flatMap((dir) => [dir, `**/${dir}`]),
];

export type DataFormat = "json" | "jsonc" | "yaml" | "toml";

export const dataFormat = (path: string): DataFormat | undefined => {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jsonc")) return "jsonc";
  if (lower.endsWith(".json"))
    return JSONC_BY_CONVENTION.some((pattern) => matchesPathOrBelow(path, pattern))
      ? "jsonc"
      : "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".toml")) return "toml";
  return undefined;
};

const PARSERS: Readonly<Record<DataFormat, (text: string) => unknown>> = {
  json: (text) => JSON.parse(text),
  jsonc: (text) => Bun.JSONC.parse(text),
  yaml: (text) => Bun.YAML.parse(text),
  toml: (text) => Bun.TOML.parse(text),
};

/** Why `text` doesn't parse as `format`, or undefined when it does. */
export const parseError = (format: DataFormat, text: string): string | undefined => {
  try {
    PARSERS[format](text);
    return undefined;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
};
