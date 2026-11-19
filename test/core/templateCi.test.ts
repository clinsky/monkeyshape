/**
 * Every workflow a template ships that installs mshape installs the version the born repo's
 * shape.toml pins, so a born repo's CI runs the mshape its config names, not the latest: the
 * common template's, and each pack's that replaces it. A pack added later is held to it too.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Glob } from "bun";

const TEMPLATE = join(import.meta.dir, "..", "..", "template");

/** The step that reads `[mshape] version` and hands it to install.sh. */
const READS_PIN =
  /version=\$\(awk '\/\^\\\[\/ \{ t = \(\$0 == "\[mshape\]"\) \} t && \/\^version \*=\/ \{[^\n]*' shape\.toml\)\n\s+curl -fsSL [^\n]*install\.sh \| MSHAPE_VERSION="\$version" sh/;

const workflows = [
  ...new Glob("**/.github/workflows/*.yml").scanSync({ cwd: TEMPLATE, dot: true }),
].sort();

describe("the templates' CI", () => {
  test("every template ships workflows: the common one, and each pack that replaces it", () => {
    expect(workflows).toContain(".github/workflows/ci.yml");
    expect(workflows).toContain("packs/python/.github/workflows/ci.yml");
    expect(workflows).toContain("packs/rust/.github/workflows/ci.yml");
  });

  for (const workflow of workflows)
    test(`${workflow} installs mshape at shape.toml's pin, if it installs mshape`, async () => {
      const text = await Bun.file(join(TEMPLATE, workflow)).text();
      // Each `install.sh | ... sh` is an install; a comment may name the script too.
      const installs = text.match(/install\.sh \|/g) ?? [];
      if (installs.length === 0) return;
      expect(text).toMatch(READS_PIN);
      // No second, unpinned install beside it.
      expect(installs).toHaveLength(1);
    });
});
