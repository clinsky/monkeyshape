/**
 * The Python pack: the import graph for `arch`, ruff's and ty's file lists for coverage, ruff
 * and ty as gate stages run through uv, the curated ruff config copied to `.mshape/ruff.toml`
 * and the curated ty rules in a table `sync` owns in `pyproject.toml`. ty, not pyright: D-ty.
 */
import type { Pack, PackFinding, RepoView } from "../pack.ts";
import { graph } from "./graph.ts";
import { lex } from "./lexer.ts";
import { effectiveTyRules, renderTyRules, TY_TABLE } from "./tyRules.ts";

export const RUFF = "ruff";
export const TY = "ty";

/** Where `sync` copies the curated ruff config, and what the repo's config must extend. */
export const RUFF_COPY = ".mshape/ruff.toml";

/** A directory of tests: checked by ruff and ty, layered by no module. */
const TEST_DIRECTORIES = new Set(["tests", "test"]);

const isTestFile = (name: string): boolean =>
  name === "conftest.py" || /^test_.*\.py$/.test(name) || /_test\.py$/.test(name);

const tomlOf = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return Bun.TOML.parse(text);
  } catch {
    return undefined;
  }
};

const at = (value: unknown, path: ReadonlyArray<string>): unknown =>
  path.reduce<unknown>(
    (node, key) =>
      typeof node === "object" && node !== null && key in node
        ? (node as Record<string, unknown>)[key]
        : undefined,
    value,
  );

/** The 1-based line of the first line matching `pattern`, if any. */
const lineOf = (text: string | undefined, pattern: RegExp): number | undefined => {
  const index = (text ?? "").split("\n").findIndex((line) => pattern.test(line));
  return index === -1 ? undefined : index + 1;
};

const normal = (path: string): string => path.replace(/^\.\//, "");

/**
 * The ruff config ruff itself reads at the root, in its order: `.ruff.toml`, `ruff.toml`, then
 * `pyproject.toml`'s `[tool.ruff]`. A pyproject without that table is no ruff config.
 */
const ruffConfig = (
  repo: RepoView,
): { readonly file: string; readonly table: ReadonlyArray<string> } | undefined => {
  for (const file of [".ruff.toml", "ruff.toml"])
    if (repo.files.includes(file)) return { file, table: [] };
  return repo.files.includes("pyproject.toml")
    ? { file: "pyproject.toml", table: ["tool", "ruff"] }
    : undefined;
};

/** Whether the repo's ruff config extends the curated copy, and where to say so if not. */
const ruffExtend = (repo: RepoView): ReadonlyArray<PackFinding> => {
  const config = ruffConfig(repo);
  const file = config?.file ?? "pyproject.toml";
  const text = repo.texts.get(file);
  const parsed = tomlOf(text);
  const extend = config === undefined ? undefined : at(parsed, [...config.table, "extend"]);
  if (typeof extend === "string" && normal(extend) === RUFF_COPY) return [];
  const where =
    config === undefined || config.table.length === 0
      ? `at the top of ${file}`
      : "under `[tool.ruff]` in pyproject.toml";
  const line =
    typeof extend === "string"
      ? lineOf(text, /^\s*extend\s*=/)
      : config?.table.length === 0
        ? undefined
        : lineOf(text, /^\s*\[tool\.ruff\]\s*$/);
  return [
    {
      kind: "ruff-extend",
      file,
      ...(line === undefined ? {} : { line }),
      message:
        typeof extend === "string"
          ? `ruff's config extends ${extend}, not the curated rules at ${RUFF_COPY}: set \`extend = "${RUFF_COPY}"\` ${where}, and override rules in that config.`
          : `ruff's config doesn't extend the curated rules at ${RUFF_COPY}, so ruff runs without them: add \`extend = "${RUFF_COPY}"\` ${where}, and override rules in that config.`,
    },
  ];
};

/** Every ruff config in the repo: ruff reads the nearest one to each file, at any depth. */
const ruffConfigs = (
  repo: RepoView,
): ReadonlyArray<{ file: string; table: ReadonlyArray<string> }> =>
  repo.files.flatMap((file) => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (file === RUFF_COPY) return [];
    if (name === "ruff.toml" || name === ".ruff.toml") return [{ file, table: [] }];
    return name === "pyproject.toml" ? [{ file, table: ["tool", "ruff"] }] : [];
  });

/** The 1-based line of `key` in the TOML table `header` (`tool.ruff.lint`), if written there. */
const keyLine = (text: string | undefined, header: string, key: string): number | undefined => {
  const lines = (text ?? "").split("\n");
  let current = "";
  for (let index = 0; index < lines.length; index++) {
    const line = (lines[index] ?? "").replace(/#.*$/, "").trim();
    const opened = /^\[([^\]]+)\]$/.exec(line);
    if (opened !== null) {
      current = (opened[1] ?? "").replace(/\s+/g, "");
      continue;
    }
    const assigned = /^([\w.-]+)\s*=/.exec(line)?.[1];
    if (
      assigned !== undefined &&
      [current, assigned].filter((part) => part !== "").join(".") === `${header}.${key}`
    )
      return index + 1;
  }
  return undefined;
};

/**
 * ruff's `lint.exclude` and `format.exclude` keep files from linting or formatting, but ruff
 * still lists them in `--show-files`, the list coverage reads: so coverage can't see what they
 * hide. Its top-level `exclude` filters that list, so coverage holds it.
 */
const ruffExclude = (repo: RepoView): ReadonlyArray<PackFinding> =>
  ruffConfigs(repo)
    .flatMap(({ file, table }) => {
      const text = repo.texts.get(file);
      const parsed = tomlOf(text);
      return (["lint", "format"] as const).flatMap((section) => {
        const exclude = at(parsed, [...table, section, "exclude"]);
        if (!Array.isArray(exclude) || exclude.length === 0) return [];
        const header = [...table, section].join(".");
        const line = keyLine(text, header, "exclude");
        return [
          {
            kind: "ruff-exclude",
            file,
            ...(line === undefined ? {} : { line }),
            message: `\`[${header}]\` \`exclude\` keeps files out of ruff's ${section === "lint" ? "lint" : "formatting"}, but ruff's file list still shows them, so coverage can't see what it hides. Move the paths to ruff's top-level \`exclude\`${table.length === 0 ? "" : " (under `[tool.ruff]`)"}, where coverage reports each file it leaves out and \`coverage.exempt\` in shape.toml holds generated or vendored code${section === "lint" ? "; or silence specific rules on those files with `per-file-ignores` and their codes" : ""}.`,
          },
        ];
      });
    })
    .concat(ruffIgnoreAll(repo));

/**
 * The same hole as `lint.exclude`, one key over: a `per-file-ignores` entry with `ALL`
 * silences every rule on its files, which ruff still lists.
 */
const ruffIgnoreAll = (repo: RepoView): ReadonlyArray<PackFinding> =>
  ruffConfigs(repo).flatMap(({ file, table }) => {
    const text = repo.texts.get(file);
    const parsed = tomlOf(text);
    // Under `lint`, and the deprecated top-level form ruff still reads.
    const keys = [["lint"], []].flatMap((section) =>
      ["per-file-ignores", "extend-per-file-ignores"].map((key) => [...section, key]),
    );
    return keys.flatMap((path) => {
      const owner = [...table, ...path.slice(0, -1)].join(".");
      const key = `${owner === "" ? "" : `\`[${owner}]\` `}\`${path.at(-1)}\``;
      const ignores = at(parsed, [...table, ...path]);
      if (typeof ignores !== "object" || ignores === null) return [];
      return Object.entries(ignores).flatMap(([pattern, codes]) => {
        if (!Array.isArray(codes) || !codes.includes("ALL")) return [];
        const quoted = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const line = lineOf(text, new RegExp(`["']${quoted}["']\\s*=.*["']ALL["']`));
        return [
          {
            kind: "ruff-exclude",
            file,
            ...(line === undefined ? {} : { line }),
            message: `${key} turns off every ruff rule for \`${pattern}\` with \`ALL\`, but ruff's file list still shows those files, so coverage can't see what it hides. Name the rules to silence by their codes; or, for generated or vendored code, move the paths to ruff's top-level \`exclude\`${table.length === 0 ? "" : " (under `[tool.ruff]`)"}, where coverage reports each file it leaves out and \`coverage.exempt\` in shape.toml holds it.`,
          },
        ];
      });
    });
  });

/**
 * A root `ty.toml` wins over `[tool.ty]` in pyproject.toml, so the curated rules that `sync`
 * writes there would be ignored.
 */
const tyConfig = (repo: RepoView): ReadonlyArray<PackFinding> =>
  repo.files.includes("ty.toml")
    ? [
        {
          kind: "ty-config",
          file: "ty.toml",
          message: `ty reads ty.toml instead of \`[tool.ty]\` in pyproject.toml, where \`mshape sync\` keeps the curated rules (\`[${TY_TABLE}]\`), so ty runs without them: move its settings under \`[tool.ty]\` in pyproject.toml and delete ty.toml; change a rule's level in shape.toml's \`[python.ty-rules]\`.`,
        },
      ]
    : [];

export const python: Pack = {
  id: "python",
  language: "Python",
  kindOf: (file) => {
    const name = file.slice(file.lastIndexOf("/") + 1);
    if (file.endsWith(".pyi")) return "declaration";
    if (!file.endsWith(".py")) return undefined;
    return isTestFile(name) ||
      file
        .split("/")
        .slice(0, -1)
        .some((segment) => TEST_DIRECTORIES.has(segment))
      ? "test"
      : "source";
  },
  comments: (file) => lex(file.text).comments,
  // ruff reports syntax errors in its stage, with its own spans.
  syntaxErrors: () => [],
  // The src layout `uv init --lib` makes; tests beside it in `tests/` are layered by no module.
  defaultSources: { include: ["src/**/*.{py,pyi}"] },
  hostSpecifiers: [
    "os",
    "os.*",
    "sys",
    "subprocess",
    "socket",
    "shutil",
    "pathlib",
    "tempfile",
    "glob",
    "signal",
    "select",
    "selectors",
    "fcntl",
    "ssl",
    "sqlite3",
    "multiprocessing",
    "multiprocessing.*",
    "asyncio.subprocess",
    "http.client",
    "http.server",
    "urllib.request",
    "ftplib",
    "smtplib",
    "webbrowser",
  ],
  graph,
  tools: [
    {
      name: RUFF,
      rule: "lint",
      uncovered: () =>
        "is not linted by ruff: its `exclude` or `extend-exclude` (in pyproject.toml's `[tool.ruff]` or ruff.toml) leaves it out. Take it out of the exclusion; if it is generated or vendored code, keep it under a directory named in `coverage.exempt` in shape.toml.",
    },
    {
      name: TY,
      rule: "typecheck",
      uncovered: () =>
        "is not type-checked by ty: `[tool.ty.src]` in pyproject.toml (its `include` or `exclude`) leaves it out. Include it; if it is generated or vendored code, keep it under a directory named in `coverage.exempt` in shape.toml.",
    },
  ],
  findings: ({ repo }) => [...ruffExtend(repo), ...ruffExclude(repo), ...tyConfig(repo)],
  findingKinds: ["ruff-extend", "ruff-exclude", "ty-config"],
  rules: [],
  baseConfigs: [
    {
      delivery: "copy",
      shipped: "config/python/ruff.toml",
      target: RUFF_COPY,
      pointer: { file: "pyproject.toml", key: "tool.ruff.extend" },
    },
    {
      delivery: "table",
      file: "pyproject.toml",
      tables: [TY_TABLE],
      content: (config) => renderTyRules(effectiveTyRules(config.python?.tyRules)),
    },
  ],
  template: "template/packs/python",
  stages: [
    // Named for their tool: a repo stage replaces a pack's by name, so names are unique
    // across packs (`mshape gate`'s table).
    { name: "ruff-format", run: ["uv", "run", "ruff", "format", "--check"], fast: true },
    { name: "ruff", run: ["uv", "run", "ruff", "check"], fast: true },
    { name: "ty", run: ["uv", "run", "ty", "check"], fast: true },
    // pytest exits 5 when it collects no tests: a born repo has none yet.
    { name: "pytest", run: ["uv", "run", "pytest"], okExit: [0, 5] },
  ],
  prerequisites: [
    {
      name: "uv",
      required: true,
      install: "install uv: `curl -LsSf https://astral.sh/uv/install.sh | sh`",
    },
    { name: RUFF, required: true, install: "`uv add --dev ruff`" },
    { name: TY, required: true, install: "`uv add --dev ty`" },
  ],
  loadFor: ["coverage"],
};
