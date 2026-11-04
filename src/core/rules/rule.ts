/** What every rule is, registry or local: the engine runs it and owns its escape hatches. */
import type { VisitorObject } from "oxc-parser";
import type { Parsed } from "../parse.ts";

export interface Finding {
  readonly offset: number;
  /** Overrides the rule's message for this finding. */
  readonly message?: string;
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
  readonly visit: (parsed: Parsed, report: (finding: Finding) => void) => VisitorObject;
  /**
   * Instead of `visit`, for an adopter's rule: its findings, or why the rule itself broke on
   * this file, which the engine reports as `rules/local-rule` so no allowance can hide it.
   */
  readonly run?: (parsed: Parsed) => ReadonlyArray<Finding> | { readonly broken: string };
}
