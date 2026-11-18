/** Base configs sync delivers: the plan's copied-configs table, and its amendment for Cargo. */
import { describe, expect, test } from "bun:test";
import { type Delivery, deliver, standing, writeTables } from "../../src/core/delivery.ts";
import { checkSync, planSync, type SyncState } from "../../src/core/sync.ts";
import type { Pack } from "../../src/packs/pack.ts";
import { config, fakePack, listed, repo } from "../support.ts";

const copy: Delivery = {
  delivery: "copy",
  pack: "python",
  file: ".mshape/ruff.toml",
  text: "line-length = 100\n",
};
const table: Delivery = {
  delivery: "table",
  pack: "rust",
  file: "Cargo.toml",
  tables: ["workspace.lints.rust", "workspace.lints.clippy"],
  text: '[workspace.lints.rust]\nunsafe_code = "forbid"\n\n[workspace.lints.clippy]\nall = { level = "deny", priority = -1 }\n',
};
const CARGO = `[workspace]
members = ["crates/*"]
resolver = "3"

[workspace.package]
edition = "2024"
`;

describe("copy", () => {
  test("equal to what the release ships passes; edited by hand or missing does not", () => {
    expect(standing(copy, copy.text)).toBe("current");
    expect(standing(copy, "line-length = 120\n")).toBe("diverged");
    expect(standing(copy, undefined)).toBe("missing");
  });

  test("sync writes the shipped text, and nothing when it is current", () => {
    expect(deliver(copy, undefined)).toBe(copy.text);
    expect(deliver(copy, "line-length = 120\n")).toBe(copy.text);
    expect(deliver(copy, copy.text)).toBeUndefined();
  });
});

describe("table", () => {
  test("missing tables are appended, every other line kept", () => {
    const written = deliver(table, CARGO) ?? "";
    expect(written).toStartWith(CARGO);
    expect(standing(table, written)).toBe("current");
    expect(Bun.TOML.parse(written)).toMatchObject({ workspace: { package: { edition: "2024" } } });
  });

  test("equal by parsed value passes: a reformat is not a failure", () => {
    const reformatted = `${CARGO}\n[workspace.lints.clippy]\nall={priority=-1,level="deny"}  # ours\n[workspace.lints.rust]\n"unsafe_code" = 'forbid'\n`;
    expect(standing(table, reformatted)).toBe("current");
  });

  test("a lint edited by hand diverges; sync rewrites only the owned tables", () => {
    const edited = `${CARGO}\n[workspace.lints.rust]\nunsafe_code = "allow"\n\n[workspace.lints.clippy]\nall = { level = "deny", priority = -1 }\n\n[profile.release]\nlto = true\n`;
    expect(standing(table, edited)).toBe("diverged");
    const written = deliver(table, edited) ?? "";
    expect(standing(table, written)).toBe("current");
    // The table after them stays, in its place.
    expect(written.endsWith("[profile.release]\nlto = true\n")).toBe(true);
    expect(written.indexOf("[workspace.package]")).toBeLessThan(written.indexOf("unsafe_code"));
  });

  test("a lint added by hand to an owned table diverges, so it can't hide there", () => {
    const added = `${CARGO}\n${table.text}missing_docs = "warn"\n`;
    expect(standing(table, added)).toBe("diverged");
  });

  // rust's probe on #105: each defines an owned table other than by its own header.
  const WORKSPACE = '[workspace]\nresolver = "3"\nmembers = ["crates/*"]\n';
  const FOREIGN: Record<string, string> = {
    "dotted under [workspace]": `${WORKSPACE}lints.rust.unsafe_code = "deny"\n`,
    "inline under [workspace]": `${WORKSPACE}lints = { rust = { unsafe_code = "deny" } }\n`,
    "inline under [workspace.lints]": `${WORKSPACE}\n[workspace.lints]\nrust = { unsafe_code = "deny" }\n`,
    "dotted under [workspace.lints]": `${WORKSPACE}\n[workspace.lints]\nrust.unsafe_code = "deny"\n`,
    "dotted, clippy only": `${WORKSPACE}\n[workspace.lints]\nclippy.todo = "allow"\n`,
  };
  for (const [name, text] of Object.entries(FOREIGN))
    test(`an owned table defined ${name}: sync writes nothing, so the file still loads`, () => {
      expect(standing(table, text)).toBe("foreign");
      expect(deliver(table, text)).toBeUndefined();
    });

  test("an owned table under its own header with another value is no foreign definition", () => {
    const own = `${WORKSPACE}\n[workspace.lints.rust]\nunsafe_code = "deny"\n`;
    expect(standing(table, own)).toBe("diverged");
    expect(Bun.TOML.parse(deliver(table, own) ?? "")).toBeDefined();
  });

  test("a file that isn't TOML is left alone", () => {
    expect(standing(table, "[workspace\n")).toBe("unparsable");
    expect(deliver(table, "[workspace\n")).toBeUndefined();
  });

  test("writeTables keeps an owned table's subtables out, and a quoted header counts", () => {
    const text = `[a]\nx = 1\n["workspace".lints.rust.extra]\ny = 2\n[b]\nz = 3\n`;
    expect(writeTables(text, ["workspace.lints.rust"], "[workspace.lints.rust]\nq = 1\n")).toBe(
      "[a]\nx = 1\n[workspace.lints.rust]\nq = 1\n\n[b]\nz = 3\n",
    );
  });
});

describe("sync's plan", () => {
  const state = (files: Record<string, string | undefined>): SyncState => ({
    ignored: [],
    beads: false,
    prime: undefined,
    prTemplate: undefined,
    settings: undefined,
    owned: [],
    replace: [],
    otherTemplates: [],
    deliveries: [copy, table].map((delivery) => ({
      delivery,
      current: files[delivery.file],
    })),
  });

  test("writes a missing copy and a missing table, and marks a new file created", () => {
    const plan = planSync(state({ "Cargo.toml": CARGO }), "");
    expect(plan.write.get(".mshape/ruff.toml")).toBe(copy.text);
    expect(standing(table, plan.write.get("Cargo.toml"))).toBe("current");
    expect(plan.created).toContain(".mshape/ruff.toml");
    expect(plan.created).not.toContain("Cargo.toml");
  });

  test("an owned table defined by dotted keys blocks sync, naming it and where its values go", () => {
    const withOverride: Delivery = { ...table, override: (t) => t.replace("workspace.", "rust.") };
    const dotted = `${CARGO}\n[workspace.lints]\nclippy.todo = "allow"\n`;
    const plan = planSync(
      { ...state({}), deliveries: [{ delivery: withOverride, current: dotted }] },
      "",
    );
    expect(plan.write.has("Cargo.toml")).toBe(false);
    expect(plan.blocked).toEqual([
      expect.stringContaining(
        "Cargo.toml defines `[workspace.lints.clippy]` as dotted keys or an inline table under a parent table",
      ),
    ]);
    expect(plan.blocked[0]).toContain(
      "move any value you meant to keep to `[rust.lints.clippy]` in shape.toml",
    );
  });

  test("a pack that sets no override: the message points at its own table in general", () => {
    const dotted = `${CARGO}\n[workspace.lints]\nclippy.todo = "allow"\n`;
    const plan = planSync({ ...state({}), deliveries: [{ delivery: table, current: dotted }] }, "");
    expect(plan.blocked[0]).toContain(
      "move any value you meant to keep to this repo's own config, or the `[rust]` table in shape.toml where the pack reads one",
    );
  });

  test("current configs write nothing; a file that isn't TOML blocks with the fix", () => {
    const current = state({
      ".mshape/ruff.toml": copy.text,
      "Cargo.toml": `${CARGO}\n${table.text}`,
    });
    const plan = planSync(current, "");
    expect(
      [...plan.write.keys()].filter(
        (file) => file !== ".github/pull_request_template.md" && file !== ".claude/settings.json",
      ),
    ).toEqual([]);
    const broken = planSync(state({ "Cargo.toml": "[workspace\n" }), "");
    expect(broken.write.has("Cargo.toml")).toBe(false);
    expect(broken.blocked.some((line) => line.startsWith("Cargo.toml isn't valid TOML"))).toBe(
      true,
    );
  });
});

test("the check names only the diverged table, and its key in shape.toml", () => {
  const delivering: Pack = {
    ...fakePack("rust", "Rust", "rs"),
    baseConfigs: [
      {
        delivery: "table",
        file: "Cargo.toml",
        tables: table.delivery === "table" ? table.tables : [],
        content: () => table.text,
        override: (t) => t.replace("workspace.", "rust."),
      },
    ],
  };
  const edited = `${CARGO}\n${table.text.replace('"deny"', '"warn"')}`;
  const snapshot = repo(
    { "Cargo.toml": edited },
    {
      packs: [listed(delivering)],
      skills: {
        link: { kind: "missing" },
        installed: new Map([["monkeyshape.json", new TextEncoder().encode('{"shared":[]}')]]),
        claudeDirectory: new Map(),
        shipped: new Map(),
      },
    },
  );
  const found = checkSync(config(), snapshot).filter((v) => v.rule === "sync/base-diverged");
  expect(found.map((v) => v.message)).toEqual([
    expect.stringMatching(
      /^holds `\[workspace\.lints\.clippy\]`, which .* Make the change in `\[rust\.lints\.clippy\]` in shape\.toml instead/,
    ),
  ]);
});

describe("the rest of the file survives a rewrite (review of #105)", () => {
  const ty: Delivery = {
    delivery: "table",
    pack: "python",
    file: "pyproject.toml",
    tables: ["tool.ty.rules"],
    text: '[tool.ty.rules]\npossibly-unresolved-reference = "error"\n',
  };
  const PYPROJECT = `[project]
name = "app"
dependencies = ["torch"]

[tool.ty.rules]
possibly-unresolved-reference = "warn"

[[tool.uv.index]]
name = "pytorch-cu124"
url = "https://download.pytorch.org/whl/cu124"
explicit = true
`;

  test("an array of tables after an owned table is kept: uv's index", () => {
    expect(standing(ty, PYPROJECT)).toBe("diverged");
    const written = deliver(ty, PYPROJECT) ?? "";
    expect(Bun.TOML.parse(written)).toMatchObject({
      tool: { uv: { index: [{ name: "pytorch-cu124", explicit: true }] } },
    });
    expect(standing(ty, written)).toBe("current");
  });

  test("a package's [[bin]] and a spaced [[ bench ]] after an owned table are kept", () => {
    const cargo = `${CARGO}\n${table.text.replace('"forbid"', '"deny"')}\n[[bin]]\nname = "app"\n\n[[ bench ]]\nname = "speed"\n`;
    const written = deliver(table, cargo) ?? "";
    expect(Bun.TOML.parse(written)).toMatchObject({
      bin: [{ name: "app" }],
      bench: [{ name: "speed" }],
    });
    expect(standing(table, written)).toBe("current");
  });

  test("a header-like line in a multi-line string: sync writes nothing rather than break the file", () => {
    const notes = `${CARGO}\n[workspace.metadata.notes]\ntext = """\n[workspace.lints.clippy]\n"""\n`;
    expect(standing(table, notes)).toBe("unwritable");
    expect(deliver(table, notes)).toBeUndefined();
    const plan = planSync(
      {
        ignored: [],
        beads: false,
        prime: undefined,
        prTemplate: undefined,
        settings: undefined,
        owned: [],
        replace: [],
        otherTemplates: [],
        deliveries: [{ delivery: table, current: notes }],
      },
      "",
    );
    expect(plan.write.has("Cargo.toml")).toBe(false);
    expect(plan.blocked[0]).toContain("would change the file outside those tables");
  });
});

test("a top-level owned table is rewritten, the rest kept", () => {
  const top: Delivery = {
    delivery: "table",
    pack: "rust",
    file: "x.toml",
    tables: ["lints"],
    text: "[lints]\na = 1\n",
  };
  const written = deliver(top, '[package]\nname = "x"\n\n[lints]\na = 2\n') ?? "";
  expect(Bun.TOML.parse(written)).toEqual({ package: { name: "x" }, lints: { a: 1 } });
  expect(standing(top, written)).toBe("current");
});

describe("a CRLF file (review of #105)", () => {
  const crlf = (text: string) => text.replaceAll("\n", "\r\n");
  const owned = `${CARGO}\n[workspace.lints.rust] # curated\nunsafe_code = "deny"\n\n[workspace.lints.clippy]\nall = { level = "deny", priority = -1 }\n`;

  test("an owned header with a trailing comment is a header, as with LF", () => {
    expect(standing(table, owned)).toBe("diverged");
    expect(standing(table, crlf(owned))).toBe("diverged");
  });

  test("sync rewrites it in CRLF throughout, and it is then current", () => {
    const written = deliver(table, crlf(owned)) ?? "";
    expect(written.replaceAll("\r\n", "")).not.toContain("\n");
    expect(standing(table, written)).toBe("current");
  });
});
