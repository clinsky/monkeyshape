/**
 * What `mshape sync` keeps in step with the installed monkeyshape, beside the shared skills:
 * `.beads/PRIME.md`, the PR template, and each listed harness's files (its hooks: Claude
 * Code's in `.claude/settings.json`), with what it wrote for a harness no longer listed removed.
 * Planning is pure; the adapter writes. The `sync` check holds a repo to the same plan, so a
 * hand edit or a missing hook fails the gate with the fix: run sync.
 *
 * Only a repo sync manages is checked: one with the shared-skills manifest, which `mshape init`
 * and `mshape sync` write. A repo that adopted monkeyshape's checks alone has none, and passes.
 *
 * PRIME.md and the PR template are written whole, so sync writes one only where it is absent,
 * already the shipped text, or recorded in the manifest as one sync owns. A file the adopter
 * wrote is left alone and named, with where its content goes; `--replace` hands it to sync.
 */
import type { Harness, HarnessFile, JsonObject } from "../harnesses/harness.ts";
import type { HarnessId, ResolvedConfig } from "../schemas/config.ts";
import { OWNABLE_FILES, PR_TEMPLATE_FILE, PRIME_FILE, prTemplate } from "./conventions.ts";
import {
  type Delivery,
  deliver,
  deliveries,
  divergedTables,
  foreignTables,
  standing,
} from "./delivery.ts";
import { LOOP_HOOKS, SYNC_COMMAND } from "./hooks.ts";
import { SKILLS_MANIFEST } from "./layout.ts";
import type { Snapshot, Violation } from "./model.ts";
import { ownedFiles } from "./skills.ts";

/** Every rule this check reports, as `sync/<kind>`; test/core/ruleCases.test.ts covers each. */
export const SYNC_RULES = [
  "prime-missing",
  "prime-diverged",
  "prime-own",
  "pr-template-missing",
  "pr-template-diverged",
  "pr-template-own",
  "pr-template-other",
  "hook-missing",
  "settings-invalid",
  "harness-file-missing",
  "harness-file-diverged",
  "harness-unlisted",
  "ignored",
  "base-missing",
  "base-diverged",
  "pin-npm-differs",
] as const;

const violation = (
  rule: (typeof SYNC_RULES)[number],
  file: string,
  message: string,
): Violation => ({
  check: "sync",
  rule: `sync/${rule}`,
  file,
  message,
});

const SYNC = `\`${SYNC_COMMAND}\``;

/** The files sync writes besides the skills and the harnesses': each must be committed. */
export const SYNCED_FILES: ReadonlyArray<string> = [PRIME_FILE, PR_TEMPLATE_FILE];

/** Every file sync writes for `harnesses` (the shipped ones), whether listed or not. */
export const harnessPaths = (harnesses: ReadonlyArray<Harness>): ReadonlyArray<string> => [
  ...new Set(harnesses.flatMap((harness) => harness.files(LOOP_HOOKS).map((file) => file.path))),
];

const ignoredMessage = (file: string, harness?: string): string => {
  const dir = file.includes("/") ? file.slice(0, file.indexOf("/")) : undefined;
  return `is on disk but ignored by git, so it isn't committed and other clones and CI don't have it${harness === undefined ? "" : `: their ${harness} sessions run none of its hooks`}. \`${SYNC_COMMAND}\` can't fix that. Find the rule with \`git check-ignore -v ${file}\`, unignore the file${dir === undefined ? "" : ` (for \`${dir}/\`, use \`${dir}/*\` plus \`!${file}\`)`}, then \`git add ${file}\` and commit it.`;
};

/**
 * A harness's file as sync sees it: listed harnesses deliver the loop's hooks; a shipped harness
 * the repo doesn't list delivers none, so what monkeyshape wrote for it goes.
 */
export interface HarnessDelivery {
  readonly harness: Harness;
  readonly listed: boolean;
  readonly file: HarnessFile;
  readonly current: string | undefined;
}

/** Each shipped harness's files, with their text now (`text` reads one; undefined is none). */
export const harnessDeliveries = (
  shipped: ReadonlyArray<Harness>,
  listed: ReadonlyArray<HarnessId>,
  text: (path: string) => string | undefined,
): ReadonlyArray<HarnessDelivery> =>
  shipped.flatMap((harness) => {
    const on = listed.includes(harness.id);
    return harness
      .files(on ? LOOP_HOOKS : [])
      .map((file) => ({ harness, listed: on, file, current: text(file.path) }));
  });

/** Whether two JSON texts hold the same value, whatever their formatting. */
const sameJson = (a: string, b: JsonObject): boolean =>
  JSON.stringify(JSON.parse(a)) === JSON.stringify(b);

/**
 * What a harness's file needs: `write` its new text, `remove` it (a whole file monkeyshape wrote
 * for a harness no longer listed), or nothing; `invalid` when an owned-entries file isn't a
 * JSON object; `kept` when an unlisted harness's whole file isn't the one monkeyshape wrote.
 * `problems` say what the file lacks, for the check.
 */
type Needs =
  | { readonly kind: "ok" }
  | { readonly kind: "write"; readonly text: string; readonly problems: ReadonlyArray<string> }
  | { readonly kind: "remove" }
  | { readonly kind: "invalid" }
  | { readonly kind: "kept" };

const needs = ({ listed, file, current }: HarnessDelivery): Needs => {
  if (file.kind === "whole") {
    if (listed)
      return current === file.text
        ? { kind: "ok" }
        : {
            kind: "write",
            text: file.text,
            problems: [
              current === undefined ? "is missing" : "differs from what monkeyshape writes",
            ],
          };
    if (current === undefined) return { kind: "ok" };
    return current === file.text ? { kind: "remove" } : { kind: "kept" };
  }
  if (!listed && current === undefined) return { kind: "ok" };
  const parsed = parseSettings(current);
  if (parsed === undefined) return { kind: "invalid" };
  if (listed) {
    const problems = file.missing(current === undefined ? undefined : parsed);
    return problems.length === 0
      ? { kind: "ok" }
      : { kind: "write", text: file.merge(current === undefined ? undefined : parsed), problems };
  }
  const merged = file.merge(parsed);
  return sameJson(merged, parsed) ? { kind: "ok" } : { kind: "write", text: merged, problems: [] };
};

/**
 * Why an adopter's own file blocks the gate, and where its content goes: for sync, which
 * leaves it alone, and for the check, which fails on it.
 */
export const ownFileMessage = (file: string): string =>
  file === PRIME_FILE
    ? `is this repo's own, not a copy sync wrote, so sync leaves it alone. But it isn't the working loop monkeyshape ships, which every session loads from it. What this repo decides goes in AGENTS.md: move what you need from it there, then run \`${SYNC_COMMAND} --replace ${PRIME_FILE}\` and commit both.`
    : `is this repo's own, not the template sync renders, so sync leaves it alone. But \`mshape track pr\` and CI's PR check need monkeyshape's sections. What your sections ask of every PR goes in AGENTS.md as a rule, answered in each PR's "What changed and why": move it there, then run \`${SYNC_COMMAND} --replace ${file}\` and commit both.`;

/**
 * Whether GitHub would read `path` as the default PR template: `pull_request_template.md` in
 * the root, `.github/` or `docs/`, in any letter case. Sync's own file is one of them.
 */
export const isPrTemplate = (path: string): boolean =>
  /^(?:\.github\/|docs\/)?pull_request_template(?:\.md|\.txt)?$/i.test(path);

/** A PR template beside sync's: the adopter's, and GitHub reads only one of them. */
export const otherTemplateMessage = (file: string): string =>
  `is a PR template too, and GitHub reads only one: beside ${PR_TEMPLATE_FILE} it isn't specified which. So sync leaves both as they are. What its sections ask of every PR goes in AGENTS.md as a rule, answered in each PR's "What changed and why": move it there, delete ${file}, then run \`${SYNC_COMMAND}\` and commit.`;

/** What sync reads of a repo. */
export interface SyncState {
  /** Synced files on disk that git ignores: sync can't make them reach other clones. */
  readonly ignored: ReadonlyArray<string>;
  /** Whether the repo uses beads: anything under `.beads/`. */
  readonly beads: boolean;
  readonly prime: string | undefined;
  readonly prTemplate: string | undefined;
  /** Each shipped harness's files, listed or not (`harnessDeliveries`). */
  readonly harnessFiles: ReadonlyArray<HarnessDelivery>;
  /** The files of `OWNABLE_FILES` sync owns now, by its manifest (`ownedFiles`). */
  readonly owned: ReadonlyArray<string>;
  /** Files the adopter asked sync to take over with `--replace`. */
  readonly replace: ReadonlyArray<string>;
  /** PR templates GitHub would read other than sync's (`isPrTemplate`). */
  readonly otherTemplates: ReadonlyArray<string>;
  /** The listed packs' `copy` and `table` configs, each with its file's text now. */
  readonly deliveries?: ReadonlyArray<{
    readonly delivery: Delivery;
    readonly current: string | undefined;
  }>;
}

/** The parsed settings, `{}` for none, undefined when it isn't a JSON object. */
const parseSettings = (text: string | undefined): Record<string, unknown> | undefined => {
  if (text === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
};

export interface SyncPlan {
  /** Repo-relative path to its new text: only files that change. */
  readonly write: ReadonlyMap<string, string>;
  /** What sync left alone, and why, one line each: for information. */
  readonly notes: ReadonlyArray<string>;
  /** What sync couldn't do and `mshape check` will still fail on: sync exits 1. */
  readonly blocked: ReadonlyArray<string>;
  /** The files sync owns after this run, for its manifest. */
  readonly owned: ReadonlyArray<string>;
  /** Of `write`, the files that don't exist yet. */
  readonly created: ReadonlyArray<string>;
  /** Files to delete: what monkeyshape wrote whole for a harness no longer listed. */
  readonly remove: ReadonlyArray<string>;
}

/** What it takes to bring a repo's synced files up to `shippedPrime` and this package's code. */
export const planSync = (state: SyncState, shippedPrime: string): SyncPlan => {
  const write = new Map<string, string>();
  const notes: Array<string> = [];
  const blocked = state.ignored.map((file) => `${file} ${ignoredMessage(file)}`);
  const owned: Array<string> = [];
  const created: Array<string> = [];
  /** Writes a whole file, unless it is the adopter's own. */
  const whole = (file: string, current: string | undefined, shipped: string) => {
    if (
      current === undefined ||
      current === shipped ||
      state.owned.includes(file) ||
      state.replace.includes(file)
    ) {
      owned.push(file);
      if (current !== shipped) write.set(file, shipped);
      if (current === undefined) created.push(file);
    } else blocked.push(`${file} ${ownFileMessage(file)}`);
  };
  if (state.beads) whole(PRIME_FILE, state.prime, shippedPrime);
  else {
    // Without beads there is no PRIME.md to keep; what sync owned before, it still owns.
    if (state.owned.includes(PRIME_FILE)) owned.push(PRIME_FILE);
    notes.push(
      `${PRIME_FILE}: not installed, since this repo has no .beads/ yet; run \`bd init\`, then sync again`,
    );
  }
  // Beside another template, writing sync's could shadow the adopter's: write neither.
  if (state.otherTemplates.length > 0) {
    if (state.owned.includes(PR_TEMPLATE_FILE)) owned.push(PR_TEMPLATE_FILE);
    for (const file of state.otherTemplates) blocked.push(`${file} ${otherTemplateMessage(file)}`);
  } else whole(PR_TEMPLATE_FILE, state.prTemplate, prTemplate());
  const remove: Array<string> = [];
  for (const delivery of state.harnessFiles) {
    const { path } = delivery.file;
    const need = needs(delivery);
    if (need.kind === "write") {
      write.set(path, need.text);
      if (delivery.current === undefined) created.push(path);
    } else if (need.kind === "remove") remove.push(path);
    else if (need.kind === "invalid" && delivery.listed)
      blocked.push(`${path}: left alone, since it isn't a JSON object; fix it, then sync again`);
    else if (need.kind === "invalid" || need.kind === "kept")
      notes.push(
        `${path}: left alone, though \`harnesses\` doesn't list ${delivery.harness.id}, since it isn't ${need.kind === "invalid" ? "a JSON object" : "the file monkeyshape wrote"}; delete it if ${delivery.harness.name} is gone`,
      );
  }
  for (const { delivery, current } of state.deliveries ?? []) {
    const message = deliveryMessage(delivery, current);
    if (message?.unfixable === true) {
      blocked.push(`${delivery.file} ${message.text}`);
      continue;
    }
    const text = deliver(delivery, write.get(delivery.file) ?? current);
    if (text === undefined) continue;
    write.set(delivery.file, text);
    if (current === undefined) created.push(delivery.file);
  }
  return {
    write,
    notes,
    blocked,
    owned: OWNABLE_FILES.filter((file) => owned.includes(file)),
    created,
    remove,
  };
};

/** One line per file sync wrote, for the CLI. */
export const formatSyncPlan = (plan: SyncPlan): ReadonlyArray<string> => [
  ...[...plan.write.keys()].map(
    (path) => `${path}: ${plan.created.includes(path) ? "added" : "updated"}`,
  ),
  ...plan.remove.map((path) => `${path}: removed`),
  ...plan.notes,
  ...plan.blocked,
];

/**
 * A synced repo's PRIME.md and PR template match what this monkeyshape ships, and its
 * settings.json runs every monkeyshape hook. Its own hooks and settings are its business.
 */
/**
 * The npm package against the pin: `mshape` runs the pinned version, while a TypeScript repo's
 * configs (`extends`) and imports resolve the package in `node_modules`. Both must be one
 * monkeyshape, or the gate runs one version's checks over the other's configs.
 */
const pinAgainstNpm = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  const pin = config.mshape;
  const npm = snapshot.installedMonkeyshape;
  if (pin === undefined || pin.dev !== undefined || npm === undefined || npm === pin.version)
    return [];
  return [
    violation(
      "pin-npm-differs",
      "shape.toml",
      `pins mshape ${pin.version}, but node_modules has the monkeyshape npm package ${npm}, which this repo's configs and imports resolve: one monkeyshape must do both. Set the monkeyshape dependency in package.json to ${pin.version} and run \`bun install\`, or pin [mshape] version ${npm} with that release's sums.`,
    ),
  ];
};

export const checkSync = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => [
  ...pinAgainstNpm(config, snapshot),
  ...syncedFiles(config, snapshot),
];

const syncedFiles = (config: ResolvedConfig, snapshot: Snapshot): ReadonlyArray<Violation> => {
  if (!snapshot.skills.installed.has(SKILLS_MANIFEST)) return [];
  const out: Array<Violation> = [...snapshot.unlisted]
    .filter((file) => SYNCED_FILES.includes(file))
    .map((file) => violation("ignored", file, ignoredMessage(file)));
  const delivered = harnessDeliveries(snapshot.harnesses ?? [], config.harnesses, (path) =>
    snapshot.texts.get(path),
  );
  for (const { file, harness, listed } of delivered)
    if (listed && snapshot.unlisted.has(file.path))
      out.push(violation("ignored", file.path, ignoredMessage(file.path, harness.name)));
  // An ignored file is reported once, as ignored: "missing" would prescribe sync, which can't help.
  const owned = ownedFiles(snapshot.skills.installed.get(SKILLS_MANIFEST));
  const prime = snapshot.unlisted.has(PRIME_FILE) ? undefined : snapshot.texts.get(PRIME_FILE);
  const beads = snapshot.files.some((file) => file.startsWith(".beads/"));
  if (beads && snapshot.shippedPrime !== undefined && !snapshot.unlisted.has(PRIME_FILE)) {
    if (prime === undefined)
      out.push(
        violation(
          "prime-missing",
          PRIME_FILE,
          `is missing, so bd's SessionStart hook prints bd's default text, which contradicts this repo's conventions (agents push, beads close when their PR merges). Run ${SYNC} and commit it.`,
        ),
      );
    else if (prime !== snapshot.shippedPrime && !owned.includes(PRIME_FILE))
      out.push(violation("prime-own", PRIME_FILE, ownFileMessage(PRIME_FILE)));
    else if (prime !== snapshot.shippedPrime)
      out.push(
        violation(
          "prime-diverged",
          PRIME_FILE,
          `differs from the copy the installed monkeyshape ships. It holds what monkeyshape decides; what this repo decides goes in AGENTS.md. Move any local change there, then run ${SYNC} and commit it.`,
        ),
      );
  }
  const template = snapshot.texts.get(PR_TEMPLATE_FILE);
  const others = snapshot.files.filter((file) => file !== PR_TEMPLATE_FILE && isPrTemplate(file));
  for (const file of others)
    out.push(violation("pr-template-other", file, otherTemplateMessage(file)));
  if (others.length > 0 || snapshot.unlisted.has(PR_TEMPLATE_FILE)) {
    // Reported above: as another template, which sync won't write beside, or as ignored.
  } else if (template === undefined)
    out.push(
      violation(
        "pr-template-missing",
        PR_TEMPLATE_FILE,
        `is missing, so PRs here have no sections to fill and CI's PR check has nothing to match. Run ${SYNC} and commit it.`,
      ),
    );
  else if (template !== prTemplate() && !owned.includes(PR_TEMPLATE_FILE))
    out.push(violation("pr-template-own", PR_TEMPLATE_FILE, ownFileMessage(PR_TEMPLATE_FILE)));
  else if (template !== prTemplate())
    out.push(
      violation(
        "pr-template-diverged",
        PR_TEMPLATE_FILE,
        `differs from the template the installed monkeyshape renders from its PR sections, which \`mshape track pr\` and CI's PR check use too. Run ${SYNC} and commit it.`,
      ),
    );
  for (const delivery of delivered) {
    const { file, harness } = delivery;
    // An ignored file is reported once, as ignored, above.
    if (snapshot.unlisted.has(file.path)) continue;
    const need = needs(delivery);
    if (need.kind === "invalid" && delivery.listed)
      out.push(
        violation(
          "settings-invalid",
          file.path,
          `isn't a JSON object, so ${harness.name} runs none of its hooks. Fix the JSON, then run ${SYNC}.`,
        ),
      );
    else if (need.kind === "remove" || (need.kind === "write" && !delivery.listed))
      out.push(
        violation(
          "harness-unlisted",
          file.path,
          `holds what monkeyshape wrote for ${harness.name}, which \`harnesses\` in shape.toml no longer lists. Run ${SYNC}, which removes only that and keeps the repo's own, and commit it; or list \`${harness.id}\` again.`,
        ),
      );
    else if (need.kind === "write" && file.kind === "owned-entries")
      out.push(
        violation(
          "hook-missing",
          file.path,
          `${need.problems.join("; ")}. Without them a ${harness.name} session misses the conventions or its track's mail at start. Run ${SYNC}, which brings monkeyshape's hooks in step and keeps your own, and commit it.`,
        ),
      );
    else if (need.kind === "write")
      out.push(
        violation(
          delivery.current === undefined ? "harness-file-missing" : "harness-file-diverged",
          file.path,
          `${need.problems.join("; ")}: monkeyshape writes it whole for ${harness.name}, which runs it. Run ${SYNC} and commit it; a change of the repo's own goes in AGENTS.md instead.`,
        ),
      );
  }
  const packs = snapshot.packs.map(({ pack }) => pack);
  for (const delivery of deliveries(config, packs, snapshot.shippedConfigs)) {
    const message = deliveryMessage(delivery, snapshot.texts.get(delivery.file));
    if (message !== undefined) out.push(violation(message.kind, delivery.file, message.text));
  }
  return out;
};

/** Why a delivered base config fails, and the fix; undefined when it is current. */
const deliveryMessage = (
  delivery: Delivery,
  current: string | undefined,
): { kind: "base-missing" | "base-diverged"; text: string; unfixable?: true } | undefined => {
  const now = standing(delivery, current);
  const named = (tables: ReadonlyArray<string>) => tables.map((t) => `\`[${t}]\``).join(", ");
  const owned = delivery.delivery === "table" ? named(delivery.tables) : "";
  /** Where a change to one owned table goes instead of here. */
  const instead = (table: string) => {
    const key = delivery.delivery === "table" ? delivery.override?.(table) : undefined;
    return key === undefined
      ? `this repo's own config, or the \`[${delivery.pack}]\` table in shape.toml where the pack reads one`
      : `\`[${key}]\` in shape.toml`;
  };
  switch (now) {
    case "current":
      return undefined;
    case "missing":
      return {
        kind: "base-missing",
        text:
          delivery.delivery === "copy"
            ? `is missing: it is the ${delivery.pack} pack's base config, which ${SYNC} writes and this repo's own config points at. Run ${SYNC} and commit it.`
            : `has none of ${owned}, the ${delivery.pack} pack's tables that ${SYNC} owns here. Run ${SYNC} and commit it.`,
      };
    case "diverged": {
      if (delivery.delivery === "copy")
        return {
          kind: "base-diverged",
          text: `differs from the ${delivery.pack} pack's base config the installed monkeyshape ships, so a hand edit here would be lost at the next sync. Change it through ${instead("")}, then run ${SYNC}.`,
        };
      const diverged = divergedTables(delivery, current ?? "");
      return {
        kind: "base-diverged",
        text: `holds ${named(diverged)}, which ${SYNC} owns, with values other than it writes, so a hand edit here would be lost at the next sync. Make the change in ${diverged.map(instead).join(" and ")} instead, then run ${SYNC}, which rewrites only the tables it owns.`,
      };
    }
    case "foreign": {
      const foreign = foreignTables(delivery, current ?? "");
      return {
        kind: "base-diverged",
        unfixable: true,
        text: `defines ${named(foreign)} as dotted keys or an inline table under a parent table, not under ${foreign.length === 1 ? "its own header" : "their own headers"}. ${SYNC} owns ${foreign.length === 1 ? "that table" : "those tables"} and can't rewrite ${foreign.length === 1 ? "it" : "them"} without defining ${foreign.length === 1 ? "it" : "them"} twice, which the file's tools reject. Delete that definition, move any value you meant to keep to ${foreign.map(instead).join(" and ")}, then run ${SYNC}.`,
      };
    }
    case "unwritable":
      return {
        kind: "base-diverged",
        unfixable: true,
        text: `holds ${owned}, which ${SYNC} owns, but rewriting them here would change the file outside those tables (a line that looks like a table header inside a multi-line string, say), so sync writes nothing. Write ${owned} as sync would yourself, each under its own header, with ${SYNC}'s values, or move the line sync misreads, then run ${SYNC}.`,
      };
    case "unparsable":
      return {
        kind: "base-diverged",
        unfixable: true,
        text: `isn't valid TOML, so ${owned}, which ${SYNC} owns, can't be compared. Fix the file, then run ${SYNC}.`,
      };
  }
};
