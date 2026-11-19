import { describe, expect, test } from "bun:test";
import { checkRules, type Rule } from "../../src/core/rules/engine.ts";
import { RULES } from "../../src/core/rules/registry.ts";
import type { Pack } from "../../src/packs/pack.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { config, fakePack, listed, repo, ruled } from "../support.ts";

const run = (files: Record<string, string>, input: ShapeConfig = {}) =>
  checkRules(config(input), repo(files)).map(
    (v) => `${v.rule} ${v.file}${v.line === undefined ? "" : `:${v.line}`}`,
  );

describe("rule engine", () => {
  test("rules apply to sources only; tests are out by default", () => {
    expect(
      run({ "src/a.ts": "throw x;", "src/a.test.ts": "throw x;", "scripts/a.ts": "throw x;" }),
    ).toEqual(["rules/no-throw src/a.ts:1"]);
  });

  test("entry files may run effects and read the host; they still may not throw", () => {
    expect(run({ "src/cli/main.ts": "Effect.runPromise(p);\nDate.now();\nthrow x;" })).toEqual([
      "rules/no-throw src/cli/main.ts:3",
    ]);
  });

  test("shape-ignore with a reason covers its line and the next", () => {
    const source =
      "// shape-ignore no-throw: the framework callback requires it\nthrow x;\nthrow y; // shape-ignore no-throw: same callback contract\n";
    expect(run({ "src/a.ts": source })).toEqual([]);
  });

  test("a shape-ignore without a reason, or suppressing nothing, is itself a violation", () => {
    expect(run({ "src/a.ts": "// shape-ignore no-throw\nthrow x;\n" })).toEqual([
      "rules/ignore-without-reason src/a.ts:1",
      "rules/no-throw src/a.ts:2",
    ]);
    expect(
      run({ "src/a.ts": "// shape-ignore no-throw: nothing here throws at all\nconst x = 1;\n" }),
    ).toEqual(["rules/unused-ignore src/a.ts:1"]);
  });

  test("allowances need a reason and must still allow something", () => {
    const allow = {
      rules: {
        "no-throw": { allow: [{ path: "src/legacy/**", reason: "pre-Effect module, ratcheting" }] },
      },
    };
    expect(run({ "src/legacy/a.ts": "throw x;" }, allow)).toEqual([]);
    expect(run({ "src/a.ts": "" }, allow)).toEqual(["rules/unused-allowance shape.config.ts:1"]);
  });

  test("a rule whose layer the repo doesn't enable: its allowance is dead config, reported", () => {
    const agentic: Rule = {
      ...(RULES.find((rule) => rule.id === "no-throw") as Rule),
      id: "agentic-only",
      layer: "agentic",
    };
    const allow = {
      rules: {
        "agentic-only": { allow: [{ path: "src/legacy/**", reason: "a reason to weigh" }] },
      },
    };
    const found = (layers: ReadonlyArray<"core" | "agentic">) =>
      checkRules(
        config({ ...allow, layers }),
        ruled(repo({ "src/legacy/a.ts": "throw x;" }), [agentic]),
      ).map((v) => v.rule);
    expect(found(["core", "agentic"])).toEqual([]);
    expect(found(["core"])).toEqual(["rules/unused-allowance"]);
  });

  test("a rule can be turned off with a reason; unknown rules are config errors", () => {
    expect(
      run(
        { "src/a.ts": "throw x;" },
        { rules: { "no-throw": { off: "this repo is a plain library" } } },
      ),
    ).toEqual([]);
    expect(run({}, { rules: { "no-such-rule": {} } })).toEqual(["rules/config shape.config.ts:1"]);
  });

  test("files that don't parse are reported", () => {
    expect(run({ "src/a.ts": "const = ;" })[0]).toStartWith("rules/syntax src/a.ts");
  });
});

describe("a rule's context", () => {
  test("resolve gives the parsed file a relative import names, and nothing for anything else", () => {
    const seen: Array<string> = [];
    const probe: Rule = {
      id: "probe",
      layer: "core",
      bugClass: "none: a probe of the context",
      message: "none: a probe of the context",
      entryExempt: false,
      visit: (parsed, _report, context) => ({
        ImportDeclaration: (node) => {
          const target = context.resolve(node.source.value);
          seen.push(`${parsed.path} ${node.source.value} -> ${target?.path ?? "undefined"}`);
        },
      }),
    };
    const source = [
      'import { X } from "../schemas/case.ts";',
      'import { Y } from "./y.ts";',
      'import { Schema } from "effect";',
      'import { Z } from "./missing.ts";',
      'import { W } from "../../../outside.ts";',
    ].join("\n");
    checkRules(
      config(),
      ruled(
        repo({
          "src/core/a.ts": source,
          "src/core/y.ts": "",
          "src/schemas/case.ts": "export const X = 1;\n",
        }),
        [probe],
      ),
    );
    expect(seen.filter((line) => line.startsWith("src/core/a.ts"))).toEqual([
      "src/core/a.ts ../schemas/case.ts -> src/schemas/case.ts",
      "src/core/a.ts ./y.ts -> src/core/y.ts",
      "src/core/a.ts effect -> undefined",
      "src/core/a.ts ./missing.ts -> undefined",
      "src/core/a.ts ../../../outside.ts -> undefined",
    ]);
  });
});

describe("each file through the pack that claims it", () => {
  /** A Rust-like pack: `//` comments by line, and every file parses. */
  const rust: Pack = {
    ...fakePack("rust", "Rust", "rs"),
    comments: ({ text }) =>
      [...text.matchAll(/\/\/(.*)/g)].map((match) => ({
        kind: "line" as const,
        text: match[1] ?? "",
        start: match.index ?? 0,
        end: (match.index ?? 0) + match[0].length,
      })),
  };
  const rustRepo = config({ packs: ["rust"], sources: { include: ["crates/**/*.rs"] } });

  test("another language's source isn't parsed as TypeScript, nor held to its rules", () => {
    const files = { "crates/a/src/lib.rs": "pub fn add(a: u64, b: u64) -> u64 { a + b }\n" };
    expect(checkRules(rustRepo, repo(files, { packs: [listed(rust)] }))).toEqual([]);
  });

  test("shape-ignore is read in the pack's comment syntax", () => {
    const files = { "crates/a/src/lib.rs": "// shape-ignore no-throw\nfn a() {}\n" };
    expect(checkRules(rustRepo, repo(files, { packs: [listed(rust)] })).map((v) => v.rule)).toEqual(
      ["rules/ignore-without-reason"],
    );
  });

  test("a file in sources no listed pack claims is not parsed", () => {
    expect(run({ "src/notes.md": "# not code {" }, { sources: { include: ["src/**"] } })).toEqual(
      [],
    );
  });
});
