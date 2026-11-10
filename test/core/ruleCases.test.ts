/**
 * Every rule id `mshape check` can report has a case that must fail and one that must pass.
 * The must-fail case proves the rule can fire; the must-pass case is valid input close to it,
 * on which the whole check must be clean, so a rule that fires on valid input (a false
 * failure) breaks here before it breaks an adopter's gate.
 *
 * A new rule id, from the registry or a check's own kinds, fails the first test until it has
 * both cases below.
 */
import { describe, expect, test } from "bun:test";
import { CHECKS, prerequisites, ruleIds, runChecks } from "../../src/core/check.ts";
import {
  PR_TEMPLATE_FILE,
  PRIME_FILE,
  PRIME_LINES,
  prTemplate,
} from "../../src/core/conventions.ts";
import { HOOKS, renderSettings, SETTINGS_FILE } from "../../src/core/hooks.ts";
import type {
  BeadSummary,
  CheckName,
  SkillFiles,
  Snapshot,
  Violation,
} from "../../src/core/model.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, repo } from "../support.ts";

interface Case {
  readonly files?: Readonly<Record<string, string>>;
  readonly config?: ShapeConfig;
  readonly options?: Parameters<typeof repo>[1];
}

interface Cases {
  readonly fail: Case;
  readonly pass: Case;
}

const lines = (n: number): string =>
  `${Array.from({ length: n }, (_, i) => `line ${i}`).join("\n")}\n`;

const REASON = "a reason a later agent can weigh";

// arch

/** Both modules optional, so a case needn't give each a file; `arch/empty-module` isn't. */
const ARCH: ShapeConfig = {
  arch: {
    modules: {
      core: { description: "pure", optional: true },
      adapters: { description: "host", mayImport: ["core"], hostAccess: true, optional: true },
    },
  },
};

const arch: Record<string, Cases> = {
  "arch/empty-module": {
    fail: {
      config: { arch: { modules: { core: { description: "pure" }, gone: { description: "x" } } } },
      files: { "src/core/a.ts": "export const a = 1;\n" },
    },
    pass: {
      config: {
        arch: {
          modules: { core: { description: "pure" }, later: { description: "x", optional: true } },
        },
      },
      files: { "src/core/a.ts": "export const a = 1;\n" },
    },
  },
  "arch/no-module-map": {
    fail: { config: {}, files: { "src/a.ts": "export const a = 1;\n" } },
    pass: { config: ARCH },
  },
  "arch/config": {
    fail: { config: { arch: { modules: { core: { description: "x", mayImport: ["nope"] } } } } },
    pass: { config: ARCH },
  },
  "arch/unknown-module": {
    fail: { files: { "src/misc/a.ts": "" } },
    pass: { files: { "src/core/a.ts": "" } },
  },
  "arch/host-access": {
    fail: { files: { "src/core/a.ts": "process.cwd();\n" } },
    pass: {
      files: {
        "src/core/a.ts":
          'const process = { cwd: () => "/" };\nprocess.cwd();\nnew Bun.Glob("*");\nBun.YAML.parse("a: 1");\nBun.TOML.parse("");\nBun.JSONC.parse("{}");\n',
        "src/adapters/b.ts": 'import { readFile } from "node:fs/promises";\nprocess.cwd();\n',
      },
    },
  },
  "arch/forbidden-package": {
    fail: { files: { "src/core/a.ts": 'import _ from "lodash";\n' } },
    pass: { files: { "src/core/a.ts": 'import { Effect } from "effect";\n' } },
  },
  "arch/manifest": {
    fail: { files: { "src/core/a.ts": 'import pkg from "../../package.json";\n' } },
    pass: {
      config: { arch: { modules: { core: { description: "x", manifest: true } } } },
      files: { "src/core/a.ts": 'import pkg from "../../package.json";\n' },
    },
  },
  "arch/unresolved-import": {
    fail: { files: { "src/core/a.ts": 'import { b } from "./b";\n', "src/core/b.ts": "" } },
    pass: { files: { "src/core/a.ts": 'import { b } from "./b.ts";\n', "src/core/b.ts": "" } },
  },
  "arch/forbidden-import": {
    fail: {
      files: {
        "src/core/a.ts": 'import { b } from "../adapters/b.ts";\n',
        "src/adapters/b.ts": "",
      },
    },
    pass: {
      files: { "src/adapters/b.ts": 'import { a } from "../core/a.ts";\n', "src/core/a.ts": "" },
    },
  },
  "arch/cycle": {
    fail: {
      files: {
        "src/core/a.ts": 'import { b } from "./b.ts";\n',
        "src/core/b.ts": 'import { a } from "./a.ts";\n',
      },
    },
    pass: { files: { "src/core/a.ts": 'import { b } from "./b.ts";\n', "src/core/b.ts": "" } },
  },
};

// refs

const DECISIONS = "# Decisions\n\n## D-real-one: A decision\nDecision: x\n";

const refs: Record<string, Cases> = {
  "refs/section-citation": {
    fail: { files: { "AGENTS.md": "As the plan says in §3.\n" } },
    pass: { files: { "AGENTS.md": "As the plan's Commands section says.\n" } },
  },
  "refs/forbidden": {
    fail: {
      config: { refs: { forbidden: [{ pattern: "acme-internal", reason: REASON }] } },
      files: { "AGENTS.md": "Ask acme-internal.\n" },
    },
    pass: {
      config: { refs: { forbidden: [{ pattern: "acme-internal", reason: REASON }] } },
      files: { "AGENTS.md": "Ask the maintainer.\n" },
    },
  },
  "refs/unknown-decision": {
    fail: { files: { "DECISIONS.md": DECISIONS, "AGENTS.md": "Per D-made-up.\n" } },
    pass: { files: { "DECISIONS.md": DECISIONS, "AGENTS.md": "Per D-real-one.\n" } },
  },
  "refs/split-code-span": {
    fail: { files: { "AGENTS.md": "Run `scripts/\nsetup.sh` first.\n" } },
    pass: {
      files: {
        "AGENTS.md": "Start a span with `` ` `` and close it.\n```\nfenced ` stray\n```\n",
      },
    },
  },
  "refs/normative-link": {
    fail: { files: { "AGENTS.md": "See notes/old.md.\n", "notes/old.md": "" } },
    pass: { files: { "AGENTS.md": "History lives in `notes/`.\n", "notes/old.md": "" } },
  },
  "refs/unknown-script": {
    fail: { files: { "AGENTS.md": "Run `bun run nope`.\n" }, options: { scripts: ["check"] } },
    pass: {
      files: { "AGENTS.md": "Run `bun run --silent check`.\n" },
      options: { scripts: ["check"] },
    },
  },
  "refs/missing-path": {
    fail: { files: { "AGENTS.md": "See `src/gone.ts` and [it](src/gone.ts).\n", "src/a.ts": "" } },
    pass: { files: { "AGENTS.md": "See `src/a.ts` and [it](src/a.ts).\n", "src/a.ts": "" } },
  },
  "refs/unused-allowance": {
    fail: {
      config: {
        refs: { rules: { "section-citation": { allow: [{ path: "docs/**", reason: REASON }] } } },
      },
      files: { "AGENTS.md": "As the plan's Commands section says.\n" },
    },
    pass: {
      config: {
        refs: { rules: { "section-citation": { allow: [{ path: "AGENTS.md", reason: REASON }] } } },
      },
      files: { "AGENTS.md": "As the plan says in §3.\n" },
    },
  },
  "refs/bead-in-code": {
    fail: {
      files: { "src/a.ts": "// see mshape-abc.1\n" },
      options: { beadIds: ["mshape-abc.1"] },
    },
    pass: {
      files: { "src/a.ts": "// TODO(mshape-abc.1): later\n" },
      options: { beadIds: ["mshape-abc.1"] },
    },
  },
};

// budgets

const AGENTS = { "AGENTS.md": "# Agents\n" };

const entry = (slug: string, overrides: Record<string, string> = {}): string => {
  const fields: Record<string, string> = {
    Decision: "Do the thing.",
    "Tempting wrong fix": "The other thing.",
    Evidence: "measured: it broke twice",
    "Enforced by": "test/a.test.ts",
    "Revisit when": "it stops being true",
    ...overrides,
  };
  return `## ${slug}: Title\n${Object.entries(fields)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n`;
};

/** A repo whose DECISIONS.md holds `entries`, with the file they're enforced by. */
const decisions = (...entries: ReadonlyArray<string>): Case => ({
  files: {
    ...AGENTS,
    "test/a.test.ts": "",
    "DECISIONS.md": `# Decisions\n\n${entries.join("\n")}`,
  },
});

const budgets: Record<string, Cases> = {
  "budgets/agents-missing": {
    fail: { files: {} },
    pass: { files: AGENTS },
  },
  "budgets/agents-lines": {
    fail: { config: { budgets: { agentsLines: 3 } }, files: { "AGENTS.md": lines(4) } },
    pass: { config: { budgets: { agentsLines: 3 } }, files: { "AGENTS.md": lines(3) } },
  },
  "budgets/claude-md": {
    fail: { files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\nAlso read this.\n" } },
    pass: { files: { ...AGENTS, "CLAUDE.md": "@AGENTS.md\n" } },
  },
  "budgets/readme-lines": {
    fail: { config: { budgets: { readmeLines: 2 } }, files: { ...AGENTS, "README.md": lines(3) } },
    pass: { config: { budgets: { readmeLines: 2 } }, files: { ...AGENTS, "README.md": lines(2) } },
  },
  "budgets/decisions-count": {
    fail: { ...decisions(entry("D-one"), entry("D-two")), config: { budgets: { decisions: 1 } } },
    pass: { ...decisions(entry("D-one")), config: { budgets: { decisions: 1 } } },
  },
  "budgets/decision-slug": {
    fail: decisions(entry("D-Not_a-slug")),
    pass: decisions(entry("D-a-slug")),
  },
  "budgets/decision-duplicate": {
    fail: decisions(entry("D-one"), entry("D-one")),
    pass: decisions(entry("D-one"), entry("D-two")),
  },
  "budgets/decision-words": {
    fail: decisions(entry("D-one", { Decision: "word ".repeat(150) })),
    pass: decisions(entry("D-one", { Decision: "word ".repeat(100) })),
  },
  "budgets/decision-field": {
    fail: decisions(entry("D-one", { "Revisit when": "" })),
    pass: decisions(entry("D-one")),
  },
  "budgets/decision-evidence": {
    fail: decisions(entry("D-one", { Evidence: "vibes" })),
    pass: decisions(entry("D-one", { Evidence: "verified: by hand" })),
  },
  "budgets/decision-unenforced": {
    fail: decisions(entry("D-one", { "Enforced by": "test/gone.test.ts" })),
    pass: decisions(
      entry("D-one", { "Enforced by": "`test/a.test.ts` (its second case)" }),
      entry("D-two", { "Enforced by": "none", Evidence: "policy" }),
    ),
  },
  "budgets/prime-lines": {
    fail: { files: { ...AGENTS, [PRIME_FILE]: lines(PRIME_LINES + 1) } },
    pass: { files: { ...AGENTS, [PRIME_FILE]: lines(PRIME_LINES) } },
  },
  "budgets/memories-count": {
    fail: {
      config: { budgets: { memories: 1 } },
      files: AGENTS,
      options: { memories: { a: "x", b: "y" } },
    },
    pass: {
      config: { budgets: { memories: 1 } },
      files: AGENTS,
      options: { memories: { a: "x" } },
    },
  },
  "budgets/memories-bytes": {
    fail: {
      config: { budgets: { memoryBytes: 4 } },
      files: AGENTS,
      options: { memories: { a: "12345" } },
    },
    pass: {
      config: { budgets: { memoryBytes: 4 } },
      files: AGENTS,
      options: { memories: { a: "1234" } },
    },
  },
  "budgets/file-lines": {
    fail: {
      config: { budgets: { fileWarnLines: 2, fileFailLines: 3 } },
      files: { ...AGENTS, "src/a.ts": lines(4) },
    },
    pass: {
      config: { budgets: { fileWarnLines: 2, fileFailLines: 3 } },
      files: { ...AGENTS, "src/a.ts": lines(3) },
    },
  },
  "budgets/unused-allowance": {
    fail: {
      config: {
        budgets: {
          fileWarnLines: 2,
          fileFailLines: 3,
          largeFiles: [{ path: "src/a.ts", reason: REASON }],
        },
      },
      files: { ...AGENTS, "src/a.ts": lines(3) },
    },
    pass: {
      config: {
        budgets: {
          fileWarnLines: 2,
          fileFailLines: 3,
          largeFiles: [{ path: "src/a.ts", reason: REASON }],
        },
      },
      files: { ...AGENTS, "src/a.ts": lines(4) },
    },
  },
};

// coverage

/** Unit tests run neither tool: what DEFAULT_CONFIG says, for cases with their own config. */
const NO_TOOLS = { prerequisites: { tsc: "optional", biome: "optional" } } as const;

const TOOLS = { "tsconfig.json": '{ "include": ["src"] }', "biome.json": "{}" };

const coverage: Record<string, Cases> = {
  "coverage/config": {
    // Only with TypeScript to cover: a repo without any needs neither config.
    fail: { files: { "biome.json": "{}", "tsconfig.json": "{ not json", "src/a.ts": "" } },
    pass: { files: { "biome.json": "{}", "tsconfig.json": "// a comment\n{}", "src/a.ts": "" } },
  },
  "coverage/typecheck": {
    fail: { files: { ...TOOLS, "scripts/a.ts": "" } },
    pass: { files: { ...TOOLS, "src/a.ts": "", "generated/b.ts": "" } },
  },
  "coverage/lint": {
    fail: {
      files: {
        ...TOOLS,
        "biome.json": '{ "files": { "includes": ["**", "!src/a.ts"] } }',
        "src/a.ts": "",
      },
    },
    pass: {
      files: {
        ...TOOLS,
        "biome.json": '{ "files": { "includes": ["**", "!src/b.ts"] } }',
        "src/a.ts": "",
      },
    },
  },
  "coverage/uncovered": {
    fail: { files: { ...TOOLS, "scripts/gen.py": "" } },
    // Declared, exempt with a reason, or another tool's file.
    pass: {
      files: { ...TOOLS, "native/a.c": "", "scripts/gen.py": "", ".beads/hooks/pre-push": "" },
      config: {
        ...NO_TOOLS,
        coverage: {
          commands: [{ files: ["native/**"], run: ["make"] }],
          exemptFiles: [{ path: "scripts/gen.py", reason: "run once, by hand, at release" }],
        },
      },
      options: {
        modes: { ".beads/hooks/pre-push": "executable" },
        commands: [{ state: "ran", code: 0, output: "" }],
      },
    },
  },
  "coverage/command-failed": {
    fail: {
      files: { ...TOOLS, "a.c": "" },
      config: { ...NO_TOOLS, coverage: { commands: [{ files: ["a.c"], run: ["cc", "a.c"] }] } },
      options: { commands: [{ state: "ran", code: 1, output: "a.c:1: error" }] },
    },
    pass: {
      files: { ...TOOLS, "a.c": "" },
      config: { ...NO_TOOLS, coverage: { commands: [{ files: ["a.c"], run: ["cc", "a.c"] }] } },
      options: { commands: [{ state: "ran", code: 0, output: "a.c:1: warning" }] },
    },
  },
  "coverage/command-unavailable": {
    fail: {
      files: { ...TOOLS, "a.c": "" },
      config: { ...NO_TOOLS, coverage: { commands: [{ files: ["a.c"], run: ["cc", "a.c"] }] } },
      options: { commands: [{ state: "unavailable", reason: "`cc` is not on PATH" }] },
    },
    pass: {
      files: { ...TOOLS, "a.c": "" },
      config: {
        ...NO_TOOLS,
        coverage: { commands: [{ files: ["a.c"], run: ["cc", "a.c"], optional: true }] },
      },
      options: { commands: [{ state: "unavailable", reason: "`cc` is not on PATH" }] },
    },
  },
  "coverage/command-unmatched": {
    fail: {
      files: { ...TOOLS, "a.c": "" },
      config: { ...NO_TOOLS, coverage: { commands: [{ files: ["a.c", "b/**"], run: ["cc"] }] } },
      options: { commands: [{ state: "ran", code: 0, output: "" }] },
    },
    pass: {
      files: TOOLS,
      config: {
        ...NO_TOOLS,
        coverage: { commands: [{ files: ["b/**"], run: ["cc"], optional: true }] },
      },
    },
  },
  "coverage/data": {
    fail: { files: { ...TOOLS, ".github/workflows/ci.yml": "jobs:\n\t- build\n" } },
    // Whole data in each format, comments where the tool allows them, a reasoned fixture.
    pass: {
      files: {
        ...TOOLS,
        ".github/workflows/ci.yml": "on: push\n",
        "tsconfig.build.json": "// c\n{}",
        "config.toml": "a = 1\n",
        "test/fixtures/bad.json": "{",
      },
      config: {
        ...NO_TOOLS,
        coverage: {
          exemptFiles: [
            { path: "test/fixtures/bad.json", reason: "broken on purpose: parser tests" },
          ],
        },
      },
    },
  },
  "coverage/exempt-unmatched": {
    fail: {
      files: TOOLS,
      config: {
        ...NO_TOOLS,
        coverage: { exemptFiles: [{ path: "old.py", reason: "kept for the record" }] },
      },
    },
    pass: {
      files: { ...TOOLS, "old.py": "" },
      config: {
        ...NO_TOOLS,
        coverage: { exemptFiles: [{ path: "old.py", reason: "kept for the record" }] },
      },
    },
  },
};

// files

const SHA = "a".repeat(64);
const VENDORED: ShapeConfig = {
  files: { vendored: [{ path: "vendor/lib-1.0.0.tgz", package: "lib", sha256: SHA }] },
};
const READ = { sha256: SHA, package: { name: "lib" } };

const filesCases: Record<string, Cases> = {
  "files/too-large": {
    fail: {
      files: { "data/big.bin": "" },
      options: { sizes: { "data/big.bin": 30 * 1024 * 1024 } },
    },
    // A reasoned exception, a recorded artifact, and bd's own files are past the cap freely.
    pass: {
      files: {
        "data/big.bin": "",
        "vendor/lib-1.0.0.tgz": "",
        ".beads/issues.jsonl": "",
      },
      config: {
        files: {
          large: [{ path: "data/big.bin", reason: "the fixture every parser test reads" }],
          vendored: [{ path: "vendor/lib-1.0.0.tgz", package: "lib", sha256: SHA }],
        },
      },
      options: {
        sizes: {
          "data/big.bin": 30 * 1024 * 1024,
          "vendor/lib-1.0.0.tgz": 5 * 1024 * 1024,
          ".beads/issues.jsonl": 5 * 1024 * 1024,
        },
        vendored: { "vendor/lib-1.0.0.tgz": READ },
      },
    },
  },
  "files/large-unmatched": {
    fail: {
      config: { files: { large: [{ path: "data/gone.bin", reason: "kept for the record" }] } },
    },
    pass: {
      files: { "data/big.bin": "" },
      config: { files: { large: [{ path: "data", reason: "fixtures every parser test reads" }] } },
    },
  },
  "files/env": {
    fail: { files: { "app/.env.local": "" } },
    // A template by its last segment, however qualified: no secret in it.
    pass: {
      files: {
        ".env.example": "",
        "app/.env.sample": "",
        ".env.local.example": "",
        ".env.production.sample": "",
        ".envrc": "",
        "env.ts": "",
      },
    },
  },
  "files/vendored-unrecorded": {
    fail: { files: { "vendor/lib-1.0.0.tgz": "" } },
    // Recorded; and an archive outside vendor/ is someone's data, not a dependency.
    pass: {
      files: { "vendor/lib-1.0.0.tgz": "", "fixtures/sample.tar.gz": "" },
      config: VENDORED,
      options: { vendored: { "vendor/lib-1.0.0.tgz": READ } },
    },
  },
  "files/vendored-missing": {
    fail: { config: VENDORED },
    pass: {
      files: { "vendor/lib-1.0.0.tgz": "" },
      config: VENDORED,
      options: { vendored: { "vendor/lib-1.0.0.tgz": READ } },
    },
  },
  "files/vendored-digest": {
    fail: {
      files: { "vendor/lib-1.0.0.tgz": "" },
      config: VENDORED,
      options: { vendored: { "vendor/lib-1.0.0.tgz": { ...READ, sha256: "b".repeat(64) } } },
    },
    pass: {
      files: { "vendor/lib-1.0.0.tgz": "" },
      config: VENDORED,
      options: { vendored: { "vendor/lib-1.0.0.tgz": READ } },
    },
  },
  "files/vendored-package": {
    fail: {
      files: { "vendor/lib-1.0.0.tgz": "" },
      config: VENDORED,
      options: { vendored: { "vendor/lib-1.0.0.tgz": { ...READ, package: { name: "other" } } } },
    },
    // Recorded by path whatever its extension: the contents say what it is.
    pass: {
      files: { "vendor/lib.bin": "" },
      config: { files: { vendored: [{ path: "vendor/lib.bin", package: "lib", sha256: SHA }] } },
      options: { vendored: { "vendor/lib.bin": READ } },
    },
  },
};

// rules: the engine's own kinds, then one per registry rule

const ALLOW_LEGACY: ShapeConfig = {
  rules: { "no-throw": { allow: [{ path: "src/legacy/**", reason: REASON }] } },
};

/** A local rule as an adopter writes one: it reports nothing on the cases above. */
const LOCAL = {
  id: "no-save",
  bugClass: "Writes that skip the merge function.",
  message: "calls save directly; write through saveMerged.",
  check: (file: { readonly text: string }) =>
    [...file.text.matchAll(/\bsave\(/g)].map((match) => match.index),
  cases: { fail: ["save(x);\n"], pass: ["saveMerged(x);\n"] },
};

const rules: Record<string, Cases> = {
  "rules/config": {
    fail: { config: { rules: { "no-such-rule": {} } } },
    pass: { config: { rules: { "no-throw": { off: "this repo is a plain library" } } } },
  },
  "rules/syntax": {
    fail: { files: { "src/a.ts": "const = ;\n" } },
    pass: { files: { "src/a.ts": "const x = 1;\n" } },
  },
  "rules/ignore-without-reason": {
    fail: { files: { "src/a.ts": "// shape-ignore no-throw\nthrow x;\n" } },
    pass: { files: { "src/a.ts": `// shape-ignore no-throw: ${REASON}\nthrow x;\n` } },
  },
  "rules/unused-ignore": {
    fail: { files: { "src/a.ts": `// shape-ignore no-throw: ${REASON}\nconst x = 1;\n` } },
    pass: { files: { "src/a.ts": `throw x; // shape-ignore no-throw: ${REASON}\n` } },
  },
  "rules/unused-allowance": {
    fail: { config: ALLOW_LEGACY, files: { "src/a.ts": "" } },
    pass: { config: ALLOW_LEGACY, files: { "src/legacy/a.ts": "throw x;\n" } },
  },
  "rules/decode-strict": {
    fail: {
      files: {
        "src/a.ts": 'import { Schema } from "effect";\nSchema.decodeUnknownSync(User)(input);\n',
      },
    },
    pass: {
      files: {
        "src/a.ts":
          'import { Schema } from "effect";\nSchema.decodeUnknownSync(User, { errors: "all", onExcessProperty: "error" })(input);\n',
      },
    },
  },
  "rules/no-nondeterminism": {
    fail: { files: { "src/a.ts": "Date.now();\n" } },
    pass: { files: { "src/a.ts": 'new Date("2026-01-01");\nEffect.all(effects);\n' } },
  },
  "rules/no-console": {
    fail: { files: { "src/core/a.ts": 'console.log("x");\n' } },
    // An entry file (src/cli/** by default) may; a local named console isn't the global.
    pass: {
      files: {
        "src/cli/main.ts": 'console.log("x");\n',
        "src/core/a.ts": "export const f = (console: { log: () => void }) => console.log();\n",
      },
    },
  },
  "rules/no-throw": {
    fail: { files: { "src/a.ts": 'throw new Error("x");\n' } },
    pass: {
      files: { "src/a.ts": "Effect.try({ try: () => JSON.parse(input), catch: (e) => e });\n" },
    },
  },
  "rules/effect-run-at-edge": {
    fail: {
      files: { "src/core/a.ts": 'import { Effect } from "effect";\nEffect.runPromise(p);\n' },
    },
    pass: {
      files: { "src/cli/main.ts": 'import { Effect } from "effect";\nEffect.runPromise(p);\n' },
    },
  },
  "rules/local-rule": {
    fail: { config: { localRules: [{ ...LOCAL, check: undefined }] } },
    pass: { config: { localRules: [LOCAL] }, files: { "src/a.ts": "saveMerged(x);\n" } },
  },
  "rules/local-cases": {
    fail: { config: { localRules: [{ ...LOCAL, cases: { fail: ["save(x);\n"], pass: [] } }] } },
    pass: { config: { localRules: [LOCAL] } },
  },
  "rules/no-error-spread": {
    fail: { files: { "src/a.ts": "const copy = { ...err, extra: 1 };\n" } },
    pass: { files: { "src/a.ts": "const copy = { ...defaults, cause: err };\n" } },
  },
};

// skills

const bytes = (entries: Record<string, string>): SkillFiles =>
  new Map(Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]));

const MANIFEST = (...shared: ReadonlyArray<string>) => JSON.stringify({ shared });

/** A repo with its own skill `own` and the shared skill `track`, linked, committed and in sync. */
const SYNCED = {
  files: {
    ".claude/skills": "",
    ".agents/skills/monkeyshape.json": "",
    ".agents/skills/own/SKILL.md": "",
    ".agents/skills/track/SKILL.md": "",
  },
  installed: { "monkeyshape.json": MANIFEST("track"), "own/SKILL.md": "o", "track/SKILL.md": "t" },
  shipped: { "track/SKILL.md": "t" },
};

const skillsCase = (
  overrides: {
    readonly files?: Record<string, string>;
    readonly link?: Snapshot["skills"]["link"];
    readonly installed?: Record<string, string>;
    readonly claudeDirectory?: Record<string, string>;
    readonly shipped?: Record<string, string>;
  } = {},
): Case => ({
  files: overrides.files ?? SYNCED.files,
  options: {
    skills: {
      link: overrides.link ?? { kind: "link", target: "../.agents/skills" },
      installed: bytes(overrides.installed ?? SYNCED.installed),
      claudeDirectory: bytes(overrides.claudeDirectory ?? {}),
      shipped: bytes(overrides.shipped ?? SYNCED.shipped),
    },
  },
});

const { ".claude/skills": _link, ...UNLINKED_FILES } = SYNCED.files;

const skills: Record<string, Cases> = {
  "skills/link": {
    fail: skillsCase({ link: { kind: "link", target: "/home/someone/repo/.agents/skills" } }),
    pass: skillsCase({ link: { kind: "link", target: "./../.agents/skills/" } }),
  },
  "skills/untracked": {
    fail: skillsCase({ files: UNLINKED_FILES }),
    pass: skillsCase(),
  },
  "skills/unlinked": {
    fail: skillsCase({ link: { kind: "directory" }, claudeDirectory: { "mine/SKILL.md": "m" } }),
    pass: skillsCase(),
  },
  "skills/diverged": {
    fail: skillsCase({ link: { kind: "directory" }, claudeDirectory: { "own/SKILL.md": "x" } }),
    pass: skillsCase(),
  },
  "skills/skill-md": {
    fail: skillsCase({
      files: { ...SYNCED.files, ".agents/skills/notes/a.md": "" },
      installed: { ...SYNCED.installed, "notes/a.md": "n" },
    }),
    pass: skillsCase({
      files: { ...SYNCED.files, ".agents/skills/own/notes.md": "" },
      installed: { ...SYNCED.installed, "own/notes.md": "n" },
    }),
  },
  "skills/manifest": {
    fail: skillsCase({ installed: { ...SYNCED.installed, "monkeyshape.json": "{ not json" } }),
    pass: skillsCase(),
  },
  "skills/sync-due": {
    fail: skillsCase({ shipped: { "track/SKILL.md": "t, updated" } }),
    pass: skillsCase(),
  },
  "skills/collision": {
    fail: skillsCase({ shipped: { ...SYNCED.shipped, "own/SKILL.md": "o" } }),
    pass: skillsCase(),
  },
};

// sync

const PRIME = "# The working loop\n";
const HOOKED = renderSettings(HOOKS);
/** A synced repo using beads: manifest, PRIME.md, PR template and every hook in place. */
const SYNCED_REPO: Record<string, string> = {
  ".agents/skills/monkeyshape.json": "",
  ".beads/config.yaml": "",
  [PRIME_FILE]: PRIME,
  [PR_TEMPLATE_FILE]: prTemplate(),
  [SETTINGS_FILE]: HOOKED,
};

const syncCase = (
  files: Record<string, string | undefined> = {},
  unlisted: ReadonlyArray<string> = [],
  /** The files the manifest says sync owns; by default an old manifest's silence: all. */
  owned?: ReadonlyArray<string>,
): Case => {
  const merged = Object.fromEntries(
    Object.entries({ ...SYNCED_REPO, ...files }).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  return {
    files: merged,
    options: {
      shippedPrime: PRIME,
      unlisted,
      skills: {
        link: { kind: "link", target: "../.agents/skills" },
        installed: bytes({
          "monkeyshape.json":
            owned === undefined ? MANIFEST() : JSON.stringify({ shared: [], files: owned }),
        }),
        claudeDirectory: new Map(),
        shipped: new Map(),
      },
    },
  };
};

const ownHook = JSON.parse(HOOKED);
ownHook.hooks.SessionStart.push({
  matcher: "",
  hooks: [{ type: "command", command: "echo mine" }],
});

const syncCases: Record<string, Cases> = {
  "sync/prime-missing": {
    fail: syncCase({ [PRIME_FILE]: undefined }),
    // No .beads/: a repo without beads has nothing for bd prime to print.
    pass: syncCase({ [PRIME_FILE]: undefined, ".beads/config.yaml": undefined }),
  },
  "sync/prime-diverged": {
    fail: syncCase({ [PRIME_FILE]: `${PRIME}A local rule.\n` }),
    pass: syncCase(),
  },
  "sync/prime-own": {
    // The adopter's own PRIME.md: sync never wrote it, so it is moved, not overwritten.
    fail: syncCase({ [PRIME_FILE]: "# Our loop\n" }, [], [PR_TEMPLATE_FILE]),
    pass: syncCase({}, [], [PR_TEMPLATE_FILE]),
  },
  "sync/pr-template-missing": {
    fail: syncCase({ [PR_TEMPLATE_FILE]: undefined }),
    pass: syncCase(),
  },
  "sync/pr-template-diverged": {
    fail: syncCase({ [PR_TEMPLATE_FILE]: "## What changed, and why\n\n## Gate\n" }),
    pass: syncCase(),
  },
  "sync/pr-template-own": {
    fail: syncCase({ [PR_TEMPLATE_FILE]: "## Summary\n" }, [], [PRIME_FILE]),
    pass: syncCase({}, [], [PRIME_FILE]),
  },
  "sync/pr-template-other": {
    // GitHub's other spelling beside sync's: which one GitHub uses isn't specified.
    fail: syncCase({ ".github/PULL_REQUEST_TEMPLATE.md": "## Summary\n" }),
    pass: syncCase(),
  },
  "sync/hook-missing": {
    fail: syncCase({ [SETTINGS_FILE]: renderSettings(HOOKS.slice(1)) }),
    // The repo's own hooks and keys beside monkeyshape's are its business.
    pass: syncCase({ [SETTINGS_FILE]: JSON.stringify({ ...ownHook, permissions: { allow: [] } }) }),
  },
  "sync/ignored": {
    // On disk but not listed by git: the snapshot has no text for it.
    fail: syncCase({ [SETTINGS_FILE]: undefined }, [SETTINGS_FILE]),
    pass: syncCase(),
  },
  "sync/settings-invalid": {
    fail: syncCase({ [SETTINGS_FILE]: "{ hooks: " }),
    pass: syncCase(),
  },
};

// beads

const bead = (
  id: string,
  status: string,
  labels: ReadonlyArray<string> = [],
  type = "task",
): BeadSummary => ({ id, title: `bead ${id}`, status, type, labels });

const beadsCases: Record<string, Cases> = {
  "beads/unowned": {
    // A repo that works in tracks: another bead, closed, carried a track label.
    fail: {
      options: { beadRows: [bead("x-1", "in_progress"), bead("x-0", "closed", ["track:a"])] },
    },
    // Owned by a track, by a label for work no track does, by being an epic, or not open.
    pass: {
      options: {
        beadRows: [
          bead("x-1", "in_progress", ["track:docs"]),
          bead("x-2", "open", ["milestone"]),
          bead("x-3", "open", ["process", "docs"]),
          bead("x-4", "open", [], "epic"),
          bead("x-5", "deferred"),
          bead("x-6", "closed"),
        ],
      },
    },
  },
  "beads/deferred-in-track": {
    fail: { options: { beadRows: [bead("x-1", "deferred", ["track:docs"])] } },
    pass: { options: { beadRows: [bead("x-1", "deferred", ["later"])] } },
  },
  "beads/todo-closed": {
    fail: {
      files: { "src/a.ts": "/* first line\n   TODO(x-1): undo the workaround */\n" },
      options: { beadRows: [bead("x-1", "closed")] },
    },
    // An open bead's TODO, and an id bd doesn't know (refs' business, not this check's).
    pass: {
      files: { "src/a.ts": "// TODO(x-1): later\n// TODO(x-9): someone else's\n" },
      options: { beadRows: [bead("x-1", "open", ["track:docs"])] },
    },
  },
};

// sources

const sourcesCases: Record<string, Cases> = {
  "sources/outside": {
    fail: { files: { "server/a.ts": "export const a = 1;\n" } },
    // In sources, a test, a declaration file, the config, and a reasoned exemption.
    pass: {
      config: { sources: { exempt: [{ path: "template/**", reason: REASON }] } },
      files: {
        "src/a.ts": "",
        "src/a.test.ts": "",
        "test/support.ts": "",
        "types/x.d.ts": "",
        "shape.config.ts": "",
        "template/t.ts": "",
      },
    },
  },
  "sources/unmatched": {
    fail: { config: { entry: ["src/main.ts"] }, files: { "src/cli.ts": "" } },
    pass: {
      config: { entry: ["src/cli.ts", { path: "src/main.ts", optional: true }] },
      files: { "src/cli.ts": "" },
    },
  },
};

// prerequisites

/** tsc and biome ran: the prerequisites cases are about bd unless they say otherwise. */
const TOOLS_RAN = { typechecked: [], linted: [] };

const prerequisitesCases: Record<string, Cases> = {
  "prerequisites/beads-failed": {
    fail: { options: { ...TOOLS_RAN, beads: { state: "failed", reason: "bd crashed" } } },
    pass: {
      options: { ...TOOLS_RAN, beads: { state: "unavailable", reason: "bd is not installed" } },
    },
  },
  "prerequisites/beads-required": {
    fail: { config: { beads: "required" }, options: { ...TOOLS_RAN, beads: { state: "absent" } } },
    pass: { config: { beads: "required" }, options: { ...TOOLS_RAN, beads: { state: "ok" } } },
  },
  "prerequisites/tool-failed": {
    fail: {
      files: { "src/a.ts": "" },
      options: { linted: [], tsc: { state: "failed", reason: "`tsc` exited 2" } },
    },
    pass: { options: TOOLS_RAN },
  },
  "prerequisites/tool-unavailable": {
    fail: { files: { "src/a.ts": "" }, options: { linted: [] } },
    // The same missing tsc, declared optional: coverage reads tsconfig instead.
    pass: { config: { prerequisites: { tsc: "optional" } }, options: { linted: [] } },
  },
};

const CASES: Record<string, Cases> = {
  ...arch,
  ...sourcesCases,
  ...refs,
  ...budgets,
  ...coverage,
  ...filesCases,
  ...rules,
  ...skills,
  ...syncCases,
  ...beadsCases,
  ...prerequisitesCases,
};

/** Configs default to the check's own: every arch case needs a module map. */
const DEFAULT_CONFIG: Partial<Record<string, ShapeConfig>> = {
  arch: ARCH,
  // Unit tests run neither tool, so coverage reads their configs, as optional tools allow.
  coverage: { prerequisites: { tsc: "optional", biome: "optional" } },
};

/** What the rule's own check reports on a case; prerequisites run whatever is selected. */
const evaluate = (id: string, input: Case): ReadonlyArray<Violation> => {
  const check = id.slice(0, id.indexOf("/"));
  const resolved = config(input.config ?? DEFAULT_CONFIG[check] ?? {});
  const snapshot = repo(input.files ?? {}, input.options);
  return check === "prerequisites"
    ? prerequisites(resolved, snapshot)
    : runChecks(resolved, snapshot, [check as CheckName]);
};

describe("rule cases", () => {
  test("every rule id has a must-fail and a must-pass case, and no case names a rule that's gone", () => {
    const ids = ruleIds();
    expect(new Set(ids).size).toBe(ids.length);
    const missing = ids.filter(
      (id) => CASES[id]?.fail === undefined || CASES[id]?.pass === undefined,
    );
    expect(missing).toEqual([]);
    expect(Object.keys(CASES).filter((id) => !ids.includes(id))).toEqual([]);
  });

  test("every check lists the kinds it reports, so none escapes the cases above", () => {
    const ids = ruleIds();
    expect(
      [...CHECKS, "prerequisites"].filter((check) => !ids.some((id) => id.startsWith(`${check}/`))),
    ).toEqual([]);
  });

  for (const [id, cases] of Object.entries(CASES)) {
    test(`${id} fires on its must-fail case`, () => {
      expect(evaluate(id, cases.fail).map((v): string => v.rule)).toContain(id);
    });
    test(`${id}'s check is clean on its must-pass case`, () => {
      expect(evaluate(id, cases.pass).map((v) => `${v.rule} ${v.file}: ${v.message}`)).toEqual([]);
    });
  }
});
