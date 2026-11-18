/**
 * Each listed pack's own findings: what isn't a rule over one source's text, such as a crate
 * that doesn't take the workspace's lints. Reported as `packs/<id>/<kind>`; every kind a pack
 * reports is in its `findingKinds`, and test/core/ruleCases.test.ts covers each.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import type { Snapshot, Violation } from "./model.ts";

export const checkPacks = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> =>
  snapshot.packs.flatMap(({ pack, load }) =>
    pack.findings({ config, repo: snapshot, load }).map(
      (finding): Violation => ({
        check: "packs",
        rule: `packs/${pack.id}/${finding.kind}`,
        file: finding.file,
        ...(finding.line === undefined ? {} : { line: finding.line }),
        message: finding.message,
      }),
    ),
  );

/** Every id the packs can report, as `packs/<id>/<kind>`. */
export const packRuleIds = (packs: ReadonlyArray<Snapshot["otherPacks"][number]>) =>
  packs.flatMap((pack) => pack.findingKinds.map((kind) => `packs/${pack.id}/${kind}`));
