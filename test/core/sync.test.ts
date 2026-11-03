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
import { planSync } from "../../src/core/sync.ts";

const ROOT = join(import.meta.dir, "..", "..");
const PRIME = "# The working loop\n";

const upToDate = {
  ignored: [],
  beads: true,
  prime: PRIME,
  prTemplate: prTemplate(),
  settings: renderSettings(HOOKS),
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
    expect(planSync(upToDate, PRIME)).toEqual({ write: new Map(), notes: [], blocked: [] });
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
