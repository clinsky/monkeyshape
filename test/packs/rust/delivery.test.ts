/**
 * The copied-configs amendment's Cargo row, against the real Rust pack: `sync` owns
 * `[workspace.lints.rust]` and `[workspace.lints.clippy]` in the root Cargo.toml.
 */
import { describe, expect, test } from "bun:test";
import { deliver, deliveries, standing } from "../../../src/core/delivery.ts";
import { checkSync, planSync, type SyncState } from "../../../src/core/sync.ts";
import { rust } from "../../../src/packs/rust/index.ts";
import { CURATED, renderLints } from "../../../src/packs/rust/lints.ts";
import { resolveConfig, type ShapeConfig } from "../../../src/schemas/config.ts";
import { listed, repo } from "../../support.ts";

const ROOT = '[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n';

const delivery = (input: ShapeConfig = {}) => {
  const [table] = deliveries(resolveConfig({ packs: ["rust"], ...input }), [rust], new Map());
  if (table === undefined) throw new Error("the Rust pack delivers no table");
  return table;
};

/** What the sync check says of `cargo` in a repo where sync has run. */
const syncFindings = (cargo: string) =>
  checkSync(
    resolveConfig({ packs: ["rust"] }),
    repo(
      { "Cargo.toml": cargo },
      {
        packs: [listed(rust)],
        skills: {
          link: { kind: "missing" },
          installed: new Map([["monkeyshape.json", new TextEncoder().encode("{}")]]),
          claudeDirectory: new Map(),
          shipped: new Map(),
        },
      },
    ),
  ).filter((v) => v.file === "Cargo.toml");

describe("the Rust pack's lint tables through sync", () => {
  test("sync writes the curated tables into a root that has none, keeping the rest", () => {
    const written = deliver(delivery(), ROOT) ?? "";
    expect(written).toStartWith(ROOT);
    expect(Bun.TOML.parse(written)).toMatchObject({ workspace: { lints: CURATED } });
    expect(standing(delivery(), written)).toBe("current");
  });

  test("a [rust.lints] override in shape.toml is what sync writes", () => {
    const table = delivery({ rust: { lints: { clippy: { todo: "allow" } } } });
    const written = Bun.TOML.parse(deliver(table, ROOT) ?? "");
    expect(written).toMatchObject({ workspace: { lints: { clippy: { todo: "allow" } } } });
  });

  test("a reformat of the tables passes the sync check", () => {
    const reformatted = `${ROOT}\n${renderLints(CURATED)
      .replace('unsafe_code = "deny"', "'unsafe_code'   =   'deny'  # ours")
      .replace('{ level = "warn", priority = -1 }', "{priority=-1,level='warn'}")}\n`;
    expect(syncFindings(reformatted)).toEqual([]);
  });

  test("a hand edit fails, naming the table and the key in shape.toml to use instead", () => {
    const edited = `${ROOT}\n${renderLints(CURATED).replace('dbg_macro = "warn"', 'dbg_macro = "allow"')}\n`;
    const [found, ...rest] = syncFindings(edited);
    expect(rest).toEqual([]);
    expect(found?.rule).toBe("sync/base-diverged");
    expect(found?.message).toContain("holds `[workspace.lints.clippy]`");
    expect(found?.message).toContain("`[rust.lints.clippy]` in shape.toml");
  });

  test("a root with no tables, where sync has run, is the sync check's: base-missing", () => {
    expect(syncFindings(ROOT).map((v) => v.rule)).toEqual(["sync/base-missing"]);
  });

  // Each wrote a second definition beside the first before #105, breaking cargo.
  test.each([
    ["dotted, under [workspace]", 'lints.rust.unsafe_code = "deny"\n'],
    ["inline, under [workspace]", 'lints = { rust = { unsafe_code = "deny" } }\n'],
    ["inline, under [workspace.lints]", '\n[workspace.lints]\nrust = { unsafe_code = "deny" }\n'],
    ["dotted, under [workspace.lints]", '\n[workspace.lints]\nrust.unsafe_code = "deny"\n'],
    ["dotted, clippy only", '\n[workspace.lints]\nclippy.todo = "allow"\n'],
  ])("an owned table defined %s blocks sync, naming where its values go", (_, extra) => {
    const state: SyncState = {
      ignored: [],
      beads: false,
      prime: undefined,
      prTemplate: undefined,
      harnessFiles: [],
      owned: [],
      replace: [],
      otherTemplates: [],
      deliveries: [{ delivery: delivery(), current: `${ROOT}${extra}` }],
    };
    const plan = planSync(state, "");
    expect(plan.write.has("Cargo.toml")).toBe(false);
    expect(plan.blocked[0]).toContain("as dotted keys or an inline table under a parent table");
    expect(plan.blocked[0]).toMatch(/`\[rust\.lints\.(rust|clippy)\]` in shape\.toml/);
  });
});
