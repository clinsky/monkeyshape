/** What every rule is, registry or local: the engine runs it and owns its escape hatches. */
import type { VisitorObject } from "oxc-parser";
import type { Parsed } from "../parse.ts";

export interface Finding {
  readonly offset: number;
  /** Overrides the rule's message for this finding. */
  readonly message?: string;
}

/** What a registry rule may ask of the repo beyond the file it is visiting. */
export interface RuleContext {
  /**
   * The parsed file a relative import specifier (`./x.ts`, `../schemas/case.ts`) names, joined
   * against the visited file's directory. Undefined for a package import, or a file the
   * snapshot hasn't read. Specifiers are exact (this repo's imports carry their extension).
   */
  readonly resolve: (specifier: string) => Parsed | undefined;
}

export interface Rule {
  readonly id: string;
  readonly layer: "core" | "agentic";
  /** The class of bug this rule removes, for the registry and `mshape rules`. */
  readonly bugClass: string;
  /** Why, and what to do instead. Shown with every violation. */
  readonly message: string;
  /** Whether composition roots (`entry`) are exempt. */
  readonly entryExempt: boolean;
  readonly visit: (
    parsed: Parsed,
    report: (finding: Finding) => void,
    context: RuleContext,
  ) => VisitorObject;
  /**
   * Instead of `visit`, for an adopter's rule: its findings, or why the rule itself broke on
   * this file, which the engine reports as `rules/local-rule` so no allowance can hide it.
   */
  readonly run?: (parsed: Parsed) => ReadonlyArray<Finding> | { readonly broken: string };
}
