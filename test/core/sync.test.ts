import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  PR_TEMPLATE_FILE,
  PRIME_FILE,
  PRIME_LINES,
  prTemplate,
} from "../../src/core/conventions.ts";
import {
  addHooks,
  HOOKS,
  missingHooks,
  renderSettings,
  SETTINGS_FILE,
} from "../../src/core/hooks.ts";
import { lineCount } from "../../src/core/model.ts";
import { isPrTemplate, planSync } from "../../src/core/sync.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PRIME = "# The working loop\n";

const upToDate = {
  ignored: [],
  beads: true,
  prime: PRIME,
  prTemplate: prTemplate(),
  settings: renderSettings(HOOKS),
  owned: [PRIME_FILE, PR_TEMPLATE_FILE],
  replace: [],
  otherTemplates: [],
};

describe("the shipped PRIME.md", () => {
  test("is within its budget, and this repo's copy is the shipped one", async () => {
    const shipped = await Bun.file(join(ROOT, "template", PRIME_FILE)).text();
    expect(lineCount(shipped)).toBeLessThanOrEqual(PRIME_LINES);
    expect(await Bun.file(join(ROOT, PRIME_FILE)).text()).toBe(shipped);
  });
});

describe("planSync", () => {
  test("writes nothing when everything is up to date", () => {
    expect(planSync(upToDate, PRIME)).toEqual({
      write: new Map(),
      notes: [],
      blocked: [],
      owned: [PRIME_FILE, PR_TEMPLATE_FILE],
    });
  });

  test("installs a missing or edited PRIME.md and PR template", () => {
    const plan = planSync({ ...upToDate, prime: undefined, prTemplate: "## Old\n" }, PRIME);
    expect(plan.write.get(PRIME_FILE)).toBe(PRIME);
    expect(plan.write.get(PR_TEMPLATE_FILE)).toBe(prTemplate());
    expect(plan.write.has(SETTINGS_FILE)).toBe(false);
  });

  test("without .beads/ leaves PRIME.md out and says how to get it", () => {
    const plan = planSync({ ...upToDate, beads: false, prime: undefined }, PRIME);
    expect(plan.write.has(PRIME_FILE)).toBe(false);
    expect(plan.notes.join("\n")).toContain("bd init");
  });

  test("creates settings.json with every hook when there is none", () => {
    const plan = planSync({ ...upToDate, settings: undefined }, PRIME);
    expect(plan.write.get(SETTINGS_FILE)).toBe(renderSettings(HOOKS));
  });

  test("leaves a settings.json that isn't JSON alone, and is blocked", () => {
    const plan = planSync({ ...upToDate, settings: "{ nope" }, PRIME);
    expect(plan.write.has(SETTINGS_FILE)).toBe(false);
    expect(plan.blocked.join("\n")).toContain(SETTINGS_FILE);
  });

  test("an ignored synced file blocks, naming the real fix, not sync", () => {
    const plan = planSync({ ...upToDate, ignored: [SETTINGS_FILE] }, PRIME);
    expect(plan.blocked.join("\n")).toContain(`git check-ignore -v ${SETTINGS_FILE}`);
    expect(planSync({ ...upToDate, beads: false, prime: undefined }, PRIME).blocked).toEqual([]);
  });
});

describe("planSync and files the adopter wrote", () => {
  const OWN_TEMPLATE = "## Summary\n\n## Testing\n";
  const adopter = { ...upToDate, owned: [], prime: "# Our loop\n", prTemplate: OWN_TEMPLATE };

  test("leaves a differing file it never wrote alone, naming where its content goes", () => {
    const plan = planSync(adopter, PRIME);
    expect(plan.write.has(PRIME_FILE)).toBe(false);
    expect(plan.write.has(PR_TEMPLATE_FILE)).toBe(false);
    expect(plan.owned).toEqual([]);
    const said = plan.blocked.join("\n");
    expect(said).toContain(`${PRIME_FILE} is this repo's own`);
    expect(said).toContain("AGENTS.md");
    expect(said).toContain(`mshape sync --replace ${PR_TEMPLATE_FILE}`);
  });

  test("takes a file that is absent or already the shipped text, and records it", () => {
    const plan = planSync(
      { ...upToDate, owned: [], prime: undefined, prTemplate: prTemplate() },
      PRIME,
    );
    expect(plan.write.get(PRIME_FILE)).toBe(PRIME);
    expect(plan.write.has(PR_TEMPLATE_FILE)).toBe(false);
    expect(plan.owned).toEqual([PRIME_FILE, PR_TEMPLATE_FILE]);
    expect(plan.blocked).toEqual([]);
  });

  test("--replace takes the file over, and from then on it is sync's", () => {
    const plan = planSync({ ...adopter, replace: [PR_TEMPLATE_FILE] }, PRIME);
    expect(plan.write.get(PR_TEMPLATE_FILE)).toBe(prTemplate());
    expect(plan.write.has(PRIME_FILE)).toBe(false);
    expect(plan.owned).toEqual([PR_TEMPLATE_FILE]);
  });

  test("a file it owns is brought up to date, as after a version bump", () => {
    const plan = planSync({ ...upToDate, prTemplate: "## Old sections\n" }, PRIME);
    expect(plan.write.get(PR_TEMPLATE_FILE)).toBe(prTemplate());
    expect(plan.blocked).toEqual([]);
  });

  test("beside another PR template GitHub reads, writes neither and names it", () => {
    const plan = planSync(
      {
        ...upToDate,
        owned: [],
        prTemplate: undefined,
        otherTemplates: [".github/PULL_REQUEST_TEMPLATE.md"],
      },
      PRIME,
    );
    expect(plan.write.has(PR_TEMPLATE_FILE)).toBe(false);
    expect(plan.owned).toEqual([PRIME_FILE]);
    expect(plan.blocked.join("\n")).toContain(
      ".github/PULL_REQUEST_TEMPLATE.md is a PR template too",
    );
  });

  test("GitHub's template locations, in any case, are templates; others aren't", () => {
    for (const path of [
      "pull_request_template.md",
      "PULL_REQUEST_TEMPLATE.md",
      ".github/Pull_Request_Template.md",
      "docs/pull_request_template.md",
      PR_TEMPLATE_FILE,
    ])
      expect(isPrTemplate(path)).toBe(true);
    for (const path of ["src/pull_request_template.md", ".github/PULL_REQUEST_TEMPLATE/a.md"])
      expect(isPrTemplate(path)).toBe(false);
  });

  test("without .beads/ keeps owning PRIME.md, so adding beads later installs it", () => {
    expect(planSync({ ...upToDate, beads: false, prime: undefined }, PRIME).owned).toEqual([
      PRIME_FILE,
      PR_TEMPLATE_FILE,
    ]);
  });
});

describe("hooks in a settings.json monkeyshape doesn't own whole", () => {
  const own = {
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo mine" }] }],
      Stop: [{ matcher: "", hooks: [{ type: "command", command: "echo bye" }] }],
    },
  };

  test("addHooks appends the missing ones and keeps the repo's own hooks and keys", () => {
    const added = JSON.parse(addHooks(own, HOOKS));
    expect(added.permissions).toEqual(own.permissions);
    expect(added.hooks.Stop).toEqual(own.hooks.Stop);
    expect(added.hooks.SessionStart[0]).toEqual(own.hooks.SessionStart[0]);
    expect(missingHooks(added, HOOKS)).toEqual([]);
  });

  test("addHooks is idempotent, and adds only what is missing", () => {
    const once = JSON.parse(addHooks(own, HOOKS));
    expect(JSON.parse(addHooks(once, HOOKS))).toEqual(once);
    const partial = JSON.parse(renderSettings(HOOKS.slice(1)));
    expect(missingHooks(partial, HOOKS)).toEqual(HOOKS.slice(0, 1));
    expect(missingHooks(JSON.parse(addHooks(partial, HOOKS)), HOOKS)).toEqual([]);
  });

  test("a hook under another matcher, or a different command, doesn't count", () => {
    const [first] = HOOKS;
    if (first === undefined) throw new Error("no hooks");
    const elsewhere = {
      hooks: {
        [first.event]: [
          { matcher: "resume", hooks: [{ type: "command", command: first.command }] },
        ],
      },
    };
    expect(missingHooks(elsewhere, [first])).toEqual([first]);
  });
});
