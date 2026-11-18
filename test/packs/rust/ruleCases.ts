/** The Rust pack's finding kinds, each with its must-fail and must-pass case. */
import { CARGO_METADATA, rust } from "../../../src/packs/rust/index.ts";
import type { Case, Cases } from "../../core/ruleCase.ts";

/** `cargo metadata` for one member, `crates/a`, as the Rust loader records it. */
const METADATA = `{"workspace_root":"/repo","workspace_members":["a"],"packages":[{"id":"a","name":"a",
"manifest_path":"/repo/crates/a/Cargo.toml","targets":[],"dependencies":[]}]}`;

/** A one-crate Rust repo: `root` is its Cargo.toml, `member` crates/a's. */
const rustRepo = (root: string, member: string): Case => ({
  config: { packs: ["rust"] },
  files: { "Cargo.toml": root, "crates/a/Cargo.toml": member },
  options: {
    packs: [{ pack: rust, load: { tools: [], outputs: new Map([[CARGO_METADATA, METADATA]]) } }],
  },
});

const BARE_ROOT = '[workspace]\nmembers = ["crates/*"]\n';
/** A root that defines both owned tables, so members are judged. */
const LINTED_ROOT = `${BARE_ROOT}\n[workspace.lints.rust]\nunsafe_code = "deny"\n\n[workspace.lints.clippy]\ntodo = "warn"\n`;
const OPTED_IN = '[package]\nname = "a"\n\n[lints]\nworkspace = true\n';

export const rustCases: Record<string, Cases> = {
  "packs/rust/workspace-lints": {
    fail: rustRepo(BARE_ROOT, ""),
    pass: rustRepo(LINTED_ROOT, OPTED_IN),
  },
  "packs/rust/member-lints": {
    fail: rustRepo(LINTED_ROOT, '[package]\nname = "a"\n'),
    pass: rustRepo(LINTED_ROOT, OPTED_IN),
  },
};
