/**
 * Each listed pack's own findings: what isn't a rule over one source's text, such as a crate
 * that doesn't take the workspace's lints. Reported as `packs/<id>/<kind>`; every kind a pack
 * reports is in its `findingKinds`, and test/core/ruleCases.test.ts covers each. A kind it
 * didn't declare would escape those cases, so it fails as `packs/undeclared-kind` instead.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import type { Snapshot, Violation } from "./model.ts";

/** What the check itself reports, beside each pack's own kinds. */
export const PACKS_RULES = ["undeclared-kind"] as const;

export const checkPacks = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> =>
  snapshot.packs.flatMap(({ pack, load }) =>
    pack.findings({ config, repo: snapshot, load }).map((finding): Violation => {
      const at = {
        file: finding.file,
        ...(finding.line === undefined ? {} : { line: finding.line }),
      };
      return pack.findingKinds.includes(finding.kind)
        ? {
            check: "packs",
            rule: `packs/${pack.id}/${finding.kind}`,
            ...at,
            message: finding.message,
          }
        : {
            check: "packs",
            rule: "packs/undeclared-kind",
            ...at,
            message: `the ${pack.id} pack reported \`${finding.kind}\`, a kind missing from its \`findingKinds\`, so no rule case covers it: a bug in monkeyshape's ${pack.id} pack, not in this repo. Its finding was: ${finding.message}`,
          };
    }),
  );

/** Every id the packs can report, as `packs/<id>/<kind>`. */
export const packRuleIds = (packs: ReadonlyArray<Snapshot["otherPacks"][number]>) =>
  packs.flatMap((pack) => pack.findingKinds.map((kind) => `packs/${pack.id}/${kind}`));
