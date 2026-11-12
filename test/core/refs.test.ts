import { describe, expect, test } from "bun:test";
import { checkRefs, pathCandidate } from "../../src/core/refs.ts";
import { config, repo } from "../support.ts";

const DECISIONS = "# Decisions\n\n## D-real-one: A decision\nDecision: x\n";

const rules = (
  files: Record<string, string>,
  input = config(),
  scripts: ReadonlyArray<string> = [],
) =>
  checkRefs(input, repo({ "DECISIONS.md": DECISIONS, ...files }, { scripts })).map((v) => v.rule);

describe("refs in docs", () => {
  test("backticked paths must exist", () => {
    expect(rules({ "AGENTS.md": "See `src/a.ts` and `src/gone.ts`.", "src/a.ts": "" })).toEqual([
      "refs/missing-path",
    ]);
  });

  test("a code span split across lines fails, since its path would never be checked", () => {
    expect(rules({ "AGENTS.md": "Run `scripts/nope.sh` first." })).toEqual(["refs/missing-path"]);
    expect(rules({ "AGENTS.md": "Run `scripts/\nnope.sh` first." })).toEqual([
      "refs/split-code-span",
    ]);
    expect(rules({ "AGENTS.md": "`a` and `b`\n```\nfenced ` stray\n```\n" })).toEqual([]);
  });

  test("valid one-line Markdown with odd backticks passes: runs pair by length, fences by kind", () => {
    const valid = {
      doubleSpan: "Start a span with `` ` `` and close it.",
      escaped: "A lone \\` is literal in Markdown.",
      longFence: "````md\n```bash\necho `date\n```\n````\n",
      tildeFence: "~~~\n```\nodd ` here\n~~~\n",
      comment: "<!-- don't ` -->",
      nested: "``a ` b`` and `c`",
      listFence:
        "1. Install:\n   - then run:\n\n     ```sh\n     cat scripts/setup.sh `# not a path claim`\n     echo `date\n     ```\n",
      listFenceExample: "1. Step\n   - sub\n\n     ```sh\n     bash `scripts/nope.sh`\n     ```\n",
      indentedCode: "Text\n\n    echo `date\n",
      indentedCodeAfterList: "- a\n\nText\n\n    ```\n    a ` b\n",
      tabCode: "Text\n\n\techo `date\n",
      tabCodeInItem: "- Step:\n\n\t\techo `date\n",
      tabsCode: "Text\n\n\t\techo `date\n",
    };
    for (const [name, text] of Object.entries(valid))
      expect([name, rules({ "AGENTS.md": text })]).toEqual([name, []]);
    // Unmatched backticks are literal text in CommonMark: only a span that pairs across a line
    // break fails, once, on the line it opens.
    expect(rules({ "AGENTS.md": "a `` b ` c" })).toEqual([]);
    expect(rules({ "AGENTS.md": "- run `bd ready --label\n  track:x` now\n" })).toEqual([
      "refs/split-code-span",
    ]);
  });

  test("bare extensions, node_modules and runtime file names are not checked", () => {
    expect(
      rules({ "AGENTS.md": "`.d.ts`, `.tsx`, `node_modules/effect/AGENTS.md`, `index.jsonl`" }),
    ).toEqual([]);
    expect(rules({ "AGENTS.md": "`gone.md` is another package's doc; `gone.ts` is ours" })).toEqual(
      ["refs/missing-path"],
    );
  });

  test("a path under a placeholder is relative to a run-time directory, not checked", () => {
    const found = checkRefs(
      config(),
      repo({
        "AGENTS.md": "It writes `state/db/` and reads `config/run.yaml`.",
        "state/README.md": "",
      }),
    );
    expect(found.map((v) => v.message)).toEqual([
      "`state/db/` does not exist in the repo. Fix the path; or, if it is relative to a directory created at run time, name that directory with a placeholder (`<workdir>/state/db`), which refs doesn't resolve.",
      "`config/run.yaml` does not exist in the repo. Fix the path; or, if it is relative to a directory created at run time, name that directory with a placeholder (`<workdir>/config/run.yaml`), which refs doesn't resolve.",
    ]);
    expect(
      rules({
        "AGENTS.md": "It writes `<workdir>/state/db/` and reads `<workdir>/config/run.yaml`.",
      }),
    ).toEqual([]);
  });

  test("bare file names resolve anywhere; package subpaths and placeholders are not paths", () => {
    expect(
      rules({
        "AGENTS.md": "`a.ts`, `effect/Schema`, `<repo>/x`, `src/**/*.ts`, `src/a.ts:12`",
        "src/a.ts": "",
      }),
    ).toEqual([]);
  });

  test("paths inside a submodule are the submodule's business", () => {
    expect(rules({ "AGENTS.md": "`vendor-sub/README.md`", "vendor-sub": "" })).toEqual([]);
  });

  test("bun run of a file checks the file, not package.json", () => {
    expect(
      rules({ "AGENTS.md": "`bun run tools/a.ts` `bun run tools/gone.ts`", "tools/a.ts": "" }),
    ).toEqual(["refs/missing-path"]);
  });

  test("bun run scripts must exist", () => {
    expect(
      rules(
        { "AGENTS.md": "`bun run check`, `bun run --silent check` and `bun run --silent nope`" },
        config(),
        ["check"],
      ),
    ).toEqual(["refs/unknown-script"]);
  });

  test("decision slugs must exist", () => {
    expect(rules({ "AGENTS.md": "D-real-one holds; D-made-up does not." })).toEqual([
      "refs/unknown-decision",
    ]);
  });

  test("relative links must exist", () => {
    expect(
      rules({ "AGENTS.md": "[ok](DECISIONS.md#d-real-one) [bad](docs/x.md) [web](https://x.dev)" }),
    ).toEqual(["refs/missing-path"]);
  });

  test("normative docs may not point at specific notes or handoffs; the README may", () => {
    const files = { "notes/2026-01-01-x.md": "", ".handoffs/a.md": "" };
    expect(rules({ ...files, "AGENTS.md": "Write investigations in notes/, not here." })).toEqual(
      [],
    );
    expect(rules({ ...files, "AGENTS.md": "See `notes/2026-01-01-x.md`." })).toEqual([
      "refs/normative-link",
    ]);
    expect(rules({ ...files, "README.md": "See `notes/2026-01-01-x.md`." })).toEqual([]);
  });

  test("normative docs may name the roadmap but not cite its sections", () => {
    const files = { "docs/roadmap.md": "# Roadmap\n" };
    expect(rules({ ...files, "AGENTS.md": "Direction lives in `docs/roadmap.md`." })).toEqual([]);
    expect(rules({ ...files, "AGENTS.md": "Per [the roadmap](docs/roadmap.md#status)." })).toEqual([
      "refs/normative-link",
    ]);
    expect(rules({ ...files, "src/a.ts": "// see docs/roadmap.md#rules\n" })).toEqual([
      "refs/normative-link",
    ]);
  });

  test("section citations are refused", () => {
    expect(rules({ "AGENTS.md": "As the design brief says in §4.2." })).toEqual([
      "refs/section-citation",
    ]);
  });

  test("fenced code blocks are examples, not claims", () => {
    expect(rules({ "AGENTS.md": "```\nsee `src/nowhere.ts` and §3\n```\n" })).toEqual([]);
  });

  test("docs outside the configured set are not read", () => {
    expect(rules({ "notes/x.md": "`src/nowhere.ts`" })).toEqual([]);
  });

  test("forbidden patterns apply to docs and comments", () => {
    const input = config({
      refs: { forbidden: [{ pattern: "ADR \\d{4}", reason: "ADRs were retired" }] },
    });
    expect(rules({ "AGENTS.md": "per ADR 0012", "src/a.ts": "// per ADR 0012\n" }, input)).toEqual([
      "refs/forbidden",
      "refs/forbidden",
    ]);
  });
});

describe("refs in plans and notes: form only", () => {
  const rules = (files: Record<string, string>, input = {}) =>
    checkRefs(config(input), repo(files)).map((v) => `${v.file}:${v.line} ${v.rule}`);

  test("a split code span or a section citation in plan/ or notes/ fails", () => {
    expect(
      rules({
        "plan/MILESTONE.md": "A `split\nspan` here.\n",
        "notes/2026-01-01-x.md": "As \u00a7 2 says.\n",
      }),
    ).toEqual([
      "plan/MILESTONE.md:1 refs/split-code-span",
      "notes/2026-01-01-x.md:1 refs/section-citation",
    ]);
  });

  test("a path, script or decision that doesn't exist (yet, or any more) doesn't", () => {
    expect(
      rules({
        "plan/MILESTONE.md": "Add `src/core/next.ts` and `bun run later`, per D-to-come.\n",
        "notes/2026-01-01-x.md": "We removed `src/core/old.ts`; see [the old doc](gone.md).\n",
      }),
    ).toEqual([]);
  });

  test("a forbidden pattern holds in plans and notes too: it bans text, not missing things", () => {
    const forbidden = [{ pattern: "internal-codename", reason: "never in this repo" }];
    expect(
      rules(
        { "plan/MILESTONE.md": "Ship internal-codename.\n", "notes/2026-01-01-x.md": "ok\n" },
        { refs: { forbidden } },
      ),
    ).toEqual(["plan/MILESTONE.md:1 refs/forbidden"]);
  });

  test("form only wins over refs.docs, and is configurable", () => {
    const files = { "plan/MILESTONE.md": "Add `src/core/next.ts`.\n" };
    expect(rules(files, { refs: { docs: ["plan/**/*.md"] } })).toEqual([]);
    expect(rules(files, { refs: { docs: ["plan/**/*.md"], formOnlyDocs: [] } })).toEqual([
      "plan/MILESTONE.md:1 refs/missing-path",
    ]);
  });
});

describe("refs in code comments", () => {
  const withBeads = (files: Record<string, string>, beadIds: ReadonlyArray<string> | undefined) =>
    checkRefs(config(), repo(files, beadIds === undefined ? {} : { beadIds })).map((v) => v.rule);
  const source =
    "// TODO(proj-a1b2): remove\n// see proj-c3d4 and proj-c3d4.2\n// keychain service proj-mcp\n";

  test("known bead ids only inside TODO(id); lookalikes that aren't beads are fine", () => {
    expect(withBeads({ "src/a.ts": source }, ["proj-a1b2", "proj-c3d4", "proj-c3d4.2"])).toEqual([
      "refs/bead-in-code",
      "refs/bead-in-code",
    ]);
  });

  test("without bd the bead check doesn't run", () => {
    expect(withBeads({ "src/a.ts": source }, undefined)).toEqual([]);
  });

  test("links into notes and unknown decisions are refused; known decisions are fine", () => {
    expect(
      rules({ "src/a.ts": "/** Why: D-real-one. Details: notes/2026-01-01-x.md */\n// D-gone\n" }),
    ).toEqual(["refs/normative-link", "refs/unknown-decision"]);
  });

  test("strings are not comments", () => {
    expect(rules({ "src/a.ts": 'const s = "notes/2026-01-01-x.md §3 D-gone";\n' })).toEqual([]);
  });
});

describe("refs.rules: off and allow per kind, as rules takes them", () => {
  const REASON = "a reason a later agent can weigh";
  const files = {
    "AGENTS.md": "As the plan says in §3.",
    "skills/a/SKILL.md": "See §2 there.",
  };

  test("an allowance silences its kind only in the paths it matches", () => {
    const allowed = config({
      refs: { rules: { "section-citation": { allow: [{ path: "skills/**", reason: REASON }] } } },
    });
    expect(
      checkRefs(allowed, repo({ "DECISIONS.md": DECISIONS, ...files })).map(
        (v) => `${v.rule} ${v.file}`,
      ),
    ).toEqual(["refs/section-citation AGENTS.md"]);
  });

  test("an allowance silences only its own kind", () => {
    const allowed = config({
      refs: { rules: { "missing-path": { allow: [{ path: "AGENTS.md", reason: REASON }] } } },
    });
    expect(rules({ "AGENTS.md": "As in §3, see `src/gone.ts`." }, allowed)).toEqual([
      "refs/section-citation",
    ]);
  });

  test("a kind turned off reports nothing; an allowance under it can't silence anything, so it's reported", () => {
    const off = config({
      refs: {
        rules: {
          "section-citation": { off: REASON, allow: [{ path: "nowhere/**", reason: REASON }] },
        },
      },
    });
    expect(rules({ ...files, "AGENTS.md": "See `src/gone.ts` in §3." }, off)).toEqual([
      "refs/missing-path",
      "refs/unused-allowance",
    ]);
    const offOnly = config({ refs: { rules: { "section-citation": { off: REASON } } } });
    expect(rules({ ...files, "AGENTS.md": "See `src/gone.ts` in §3." }, offOnly)).toEqual([
      "refs/missing-path",
    ]);
  });

  test("a bead-in-code allowance isn't unused where bd and its export are missing", () => {
    const allowed = config({
      refs: { rules: { "bead-in-code": { allow: [{ path: "src/a.ts", reason: REASON }] } } },
    });
    const files = { "DECISIONS.md": DECISIONS, "src/a.ts": "// see x-1 here\n" };
    const noBd = repo(files, { beads: { state: "unavailable", reason: "bd is not on PATH" } });
    expect(checkRefs(allowed, noBd)).toEqual([]);
    // Where it runs, the allowance is tested as any other.
    expect(checkRefs(allowed, repo(files, { beadIds: ["x-1"] }))).toEqual([]);
    expect(checkRefs(allowed, repo(files, { beadIds: [] })).map((v) => v.rule)).toEqual([
      "refs/unused-allowance",
    ]);
  });

  test("an allowance that silences nothing is reported, naming it", () => {
    const stale = config({
      refs: { rules: { "missing-path": { allow: [{ path: "docs/**", reason: REASON }] } } },
    });
    const found = checkRefs(stale, repo({ "DECISIONS.md": DECISIONS, "AGENTS.md": "Fine." }));
    expect(found.map((v) => [v.rule, v.message])).toEqual([
      [
        "refs/unused-allowance",
        "refs.rules.missing-path.allow 'docs/**' allows nothing; delete it",
      ],
    ]);
  });
});

describe("pathCandidate", () => {
  test("strips a line suffix and a trailing slash", () => {
    expect(pathCandidate("src/a.ts:12")).toBe("src/a.ts");
    expect(pathCandidate("src/core/")).toBe("src/core");
    expect(pathCandidate("bun test")).toBeUndefined();
    expect(pathCandidate("https://x.dev/a")).toBeUndefined();
  });
});
