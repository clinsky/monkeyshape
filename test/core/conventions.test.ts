import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  GATE_COMMAND,
  GATE_SCRIPT,
  missingPrSections,
  PR_SECTIONS,
  PR_SIZE,
  PR_TEMPLATE_FILE,
  parsePrBody,
  prSizeNote,
  prSkeleton,
  prTemplate,
  setPrSections,
} from "../../src/core/conventions.ts";
import { scaffold } from "../../src/core/scaffold.ts";

const ROOT = join(import.meta.dir, "..", "..");

const toolchain = {
  bun: "1.4.2",
  monkeyshape: "0.2.0",
  effect: "4.0.0",
  biome: "2.5.15",
  typescript: "7.0.2",
  typesBun: "1.4.2",
};

describe("PR template", () => {
  test("this repo's PR template is the rendered PR_SECTIONS", async () => {
    // To regenerate: bun -e 'import { prTemplate, PR_TEMPLATE_FILE } from
    //   "./src/core/conventions.ts"; await Bun.write(PR_TEMPLATE_FILE, prTemplate())'
    expect(await Bun.file(join(ROOT, PR_TEMPLATE_FILE)).text()).toBe(prTemplate());
  });

  test("a born repo's PR template is the rendered PR_SECTIONS", () => {
    expect(scaffold("demo", new Map(), toolchain).get(PR_TEMPLATE_FILE)).toBe(prTemplate());
  });

  test("the template has every section, in order, each with its purpose", () => {
    const sections = parsePrBody(prTemplate());
    expect(sections.map((section) => section.name)).toEqual(PR_SECTIONS.map((s) => s.name));
    for (const [index, section] of sections.entries())
      expect(section.text).toBe(`<!-- ${PR_SECTIONS[index]?.purpose} -->`);
  });
});

describe("gate", () => {
  test("a born repo's gate script is the one GATE_COMMAND runs", () => {
    const pkg = JSON.parse(scaffold("demo", new Map(), toolchain).get("package.json") ?? "{}");
    expect(pkg.scripts[GATE_SCRIPT]).toContain("bun test");
    expect(GATE_COMMAND).toBe(`bun run ${GATE_SCRIPT}`);
  });

  test("this repo's gate script is the same one", async () => {
    const pkg = await Bun.file(join(ROOT, "package.json")).json();
    expect(pkg.scripts[GATE_SCRIPT]).toContain("bun test");
  });
});

describe("prSkeleton", () => {
  test("fills given sections and leaves placeholders under the rest", () => {
    const body = prSkeleton({ Gate: "\n\n  394 pass\n 0 fail  \n\n" });
    const gate = parsePrBody(body).find((section) => section.name === "Gate");
    expect(gate?.text).toBe("  394 pass\n 0 fail");
    expect(body).toContain("<!-- The narrative:");
    expect(missingPrSections(body)).not.toContain("Gate");
  });
});

describe("parsePrBody", () => {
  test("keeps text before the first heading, and ignores headings in fenced code", () => {
    const body = "intro\n\n## Gate\n\n```\n## not a heading\n```\n\n## Beads\n\n- a-1\n";
    expect(parsePrBody(body)).toEqual([
      { name: "", text: "intro" },
      { name: "Gate", text: "```\n## not a heading\n```" },
      { name: "Beads", text: "- a-1" },
    ]);
  });

  test("reads closing hashes and CRLF line endings", () => {
    expect(parsePrBody("## Gate ##\r\nok\r\n")).toEqual([{ name: "Gate", text: "ok" }]);
  });

  test("a level-3 heading stays inside its section", () => {
    expect(parsePrBody("## Evidence\n\n### Run 1\n\nout").map((s) => s.name)).toEqual(["Evidence"]);
  });
});

describe("missingPrSections", () => {
  test("names the required sections a body lacks, and not the optional ones", () => {
    expect(missingPrSections("## What changed and why\n\nx\n\n## Gate\n\nok")).toEqual([
      "Evidence",
      "Not done",
      "Beads",
    ]);
  });

  test("a heading only inside a code block doesn't count", () => {
    expect(missingPrSections("```\n## Gate\n```")).toContain("Gate");
  });

  test("a heading left empty, or with only its placeholder, is missing", () => {
    const required = PR_SECTIONS.filter((s) => s.required).map((s) => s.name);
    expect(missingPrSections(prTemplate())).toEqual(required);
    expect(missingPrSections(required.map((name) => `## ${name}\n`).join(""))).toEqual(required);
    const filled = Object.fromEntries(required.map((name) => [name, "x <!-- note -->"]));
    expect(missingPrSections(prSkeleton(filled))).toEqual([]);
  });
});

describe("setPrSections", () => {
  const written = [
    "## What changed and why",
    "",
    "My narrative, by hand.",
    "",
    "## Gate",
    "",
    "stale",
    "",
    "## Reviewer notes",
    "",
    "A section of my own.",
    "",
  ].join("\n");

  test("replaces only the given sections and keeps the rest verbatim", () => {
    const body = setPrSections(written, { Gate: "394 pass" });
    expect(body).toBe(written.replace("stale", "394 pass"));
  });

  test("puts a missing section after the known one that precedes it", () => {
    const body = setPrSections(written, { Evidence: "ran it" });
    expect(parsePrBody(body).map((s) => s.name)).toEqual([
      "What changed and why",
      "Evidence",
      "Gate",
      "Reviewer notes",
    ]);
  });

  test("puts a missing first section after the text before any heading", () => {
    const body = setPrSections("Closes nothing.\n\n## Gate\n\nok\n", {
      "What changed and why": "x",
    });
    expect(parsePrBody(body).map((s) => s.name)).toEqual(["", "What changed and why", "Gate"]);
  });

  test("a body with no sections gets the given ones in order", () => {
    expect(setPrSections("", { Beads: "b", Gate: "g" })).toBe("## Gate\n\ng\n\n## Beads\n\nb\n");
  });

  test("keeps an untouched section's leading indentation byte for byte", () => {
    const indented = [
      "## Evidence",
      "",
      "    $ mshape check",
      "    ok",
      "",
      "## Not done",
      "",
      "  - nested item",
      "",
      "## Gate",
      "",
      "stale",
      "",
    ].join("\n");
    expect(setPrSections(indented, { Gate: "411 pass" })).toBe(
      indented.replace("stale", "411 pass"),
    );
    expect(parsePrBody(indented)[0]?.text).toBe("    $ mshape check\n    ok");
  });

  test("is idempotent", () => {
    const once = setPrSections(written, { Gate: "394 pass", Beads: "- x-1" });
    expect(setPrSections(once, { Gate: "394 pass", Beads: "- x-1" })).toBe(once);
  });
});

describe("prSizeNote", () => {
  test("says where a PR sits against the batching default", () => {
    expect(prSizeNote(PR_SIZE.min - 1)).toContain("below the batching default");
    expect(prSizeNote(PR_SIZE.min)).toContain("within the batching default");
    expect(prSizeNote(PR_SIZE.max)).toContain("within the batching default");
    expect(prSizeNote(PR_SIZE.max + 1)).toContain("above the batching default");
    expect(prSizeNote(1500)).toBe(
      "1500 changed lines: within the batching default (1000 to 2500 changed lines).",
    );
  });
});
