/**
 * The sync check's must-fail and must-pass cases, and the case types every check's share:
 * split from ruleCases.test.ts, which runs them all, to keep it under its line budget.
 */
import { PR_TEMPLATE_FILE, PRIME_FILE, prTemplate } from "../../src/core/conventions.ts";
import { HOOKS, renderSettings, SETTINGS_FILE } from "../../src/core/hooks.ts";
import type { SkillFiles } from "../../src/core/model.ts";
import type { Pack } from "../../src/packs/pack.ts";
import type { ShapeConfig } from "../../src/schemas/config.ts";
import { fakePack, listed, type repo } from "../support.ts";

export interface Case {
  readonly files?: Readonly<Record<string, string>>;
  readonly config?: ShapeConfig;
  readonly options?: Parameters<typeof repo>[1];
}

export interface Cases {
  readonly fail: Case;
  readonly pass: Case;
}

export const bytes = (entries: Record<string, string>): SkillFiles =>
  new Map(Object.entries(entries).map(([path, text]) => [path, new TextEncoder().encode(text)]));

export const MANIFEST = (...shared: ReadonlyArray<string>) => JSON.stringify({ shared });

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

/** A pack delivering one config by `copy` and one by `table`, as python's and rust's will. */
const DELIVERING: Pack = {
  ...fakePack("rust", "Rust", "rs"),
  baseConfigs: [
    {
      delivery: "copy",
      shipped: "config/rust/rustfmt.toml",
      target: ".mshape/rustfmt.toml",
      pointer: { file: "rustfmt.toml", key: "extend" },
    },
    {
      delivery: "table",
      file: "Cargo.toml",
      tables: ["workspace.lints.rust"],
      content: () => '[workspace.lints.rust]\nunsafe_code = "forbid"\n',
    },
  ],
};
const RUSTFMT = "max_width = 100\n";
const CARGO =
  '[workspace]\nmembers = ["crates/*"]\n\n[workspace.lints.rust]\nunsafe_code = "forbid"\n';

/** A synced repo listing DELIVERING, its configs as sync writes them unless `files` says. */
const deliveryCase = (files: Record<string, string | undefined> = {}): Case => {
  const base = syncCase({ ".mshape/rustfmt.toml": RUSTFMT, "Cargo.toml": CARGO, ...files });
  return {
    ...base,
    options: {
      ...base.options,
      packs: [listed(DELIVERING)],
      shippedConfigs: { "config/rust/rustfmt.toml": RUSTFMT },
    },
  };
};

export const syncCases: Record<string, Cases> = {
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
  "sync/pin-npm-differs": {
    fail: {
      config: { mshape: { version: "0.6.0" } },
      options: { installedMonkeyshape: "0.5.0" },
    },
    // The same version, or this repo's own source (dev), which has no npm copy to match.
    pass: {
      config: { mshape: { version: "0.6.0", dev: ["bun", "src/cli/main.ts"] } },
      options: { installedMonkeyshape: "0.5.0" },
    },
  },
  "sync/ignored": {
    // On disk but not listed by git: the snapshot has no text for it.
    fail: syncCase({ [SETTINGS_FILE]: undefined }, [SETTINGS_FILE]),
    pass: syncCase(),
  },
  "sync/base-missing": {
    fail: deliveryCase({ ".mshape/rustfmt.toml": undefined }),
    pass: deliveryCase(),
  },
  "sync/base-diverged": {
    fail: deliveryCase({ "Cargo.toml": CARGO.replace('"forbid"', '"allow"') }),
    // The same tables, reformatted: compared by value.
    pass: deliveryCase({
      "Cargo.toml":
        '[workspace]\nmembers = [ "crates/*" ]\n[workspace.lints.rust]\nunsafe_code="forbid" # ours\n',
    }),
  },
  "sync/settings-invalid": {
    fail: syncCase({ [SETTINGS_FILE]: "{ hooks: " }),
    pass: syncCase(),
  },
};
