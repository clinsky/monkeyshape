/**
 * Shared skills: the package's `skills/<name>/` copied into a repo's `.agents/skills/<name>/`,
 * which Claude Code reaches through the committed relative link `.claude/skills`
 * (D-skills-link). Sync records the names it installed in a manifest; any other skill is the
 * repo's own and is never touched, even when the package starts shipping one of that name. A
 * shared skill is replaced whole, and one the package stops shipping is removed.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import { CLAUDE_SKILLS_LINK, CLAUDE_SKILLS_TARGET, SKILLS_DIR, SKILLS_MANIFEST } from "./layout.ts";
import type { SkillFiles, Snapshot, Violation } from "./model.ts";
import { join } from "./paths.ts";

export interface SkillSync {
  readonly added: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  /** Shared skills the package no longer ships: removed whole. */
  readonly retired: ReadonlyArray<string>;
  /** Skills of the repo's own whose name the package now ships: left alone, and reported. */
  readonly collisions: ReadonlyArray<string>;
  /** Files to write, the manifest included when it changes. */
  readonly write: SkillFiles;
  /** Files of updated shared skills that the package no longer has. */
  readonly remove: ReadonlyArray<string>;
}

const skillOf = (path: string): string => path.slice(0, path.indexOf("/"));

const bySkill = (files: SkillFiles): ReadonlyMap<string, SkillFiles> => {
  const out = new Map<string, Map<string, Uint8Array>>();
  for (const [path, bytes] of files) {
    if (!path.includes("/")) continue;
    const skill = skillOf(path);
    out.set(skill, (out.get(skill) ?? new Map()).set(path, bytes));
  }
  return out;
};

const equalBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && a.length === b.length && a.every((byte, i) => byte === b[i]);

const same = (a: SkillFiles, b: SkillFiles): boolean =>
  a.size === b.size && [...b].every(([path, bytes]) => equalBytes(a.get(path), bytes));

/** The shared skill names in an installed manifest; undefined when it isn't sync's format. */
export const parseManifest = (bytes: Uint8Array): ReadonlyArray<string> | undefined => {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const shared =
      typeof value === "object" && value !== null && "shared" in value ? value.shared : undefined;
    return Array.isArray(shared) && shared.every((name) => typeof name === "string")
      ? shared
      : undefined;
  } catch {
    return undefined;
  }
};

const manifest = (shared: ReadonlyArray<string>): Uint8Array =>
  new TextEncoder().encode(
    `${JSON.stringify(
      {
        about: "The shared skills `mshape skills sync` installed. Written by sync; don't edit.",
        shared,
      },
      null,
      2,
    )}\n`,
  );

/** The installed manifest's names: none when there is no manifest or it can't be read. */
const sharedNames = (installed: SkillFiles): ReadonlyArray<string> => {
  const bytes = installed.get(SKILLS_MANIFEST);
  return bytes === undefined ? [] : (parseManifest(bytes) ?? []);
};

/** What it takes to bring the installed shared skills up to the package's. */
export const syncSkills = (shipped: SkillFiles, installed: SkillFiles): SkillSync => {
  const installedBySkill = bySkill(installed);
  const shippedBySkill = bySkill(shipped);
  const shared = sharedNames(installed);
  const added: Array<string> = [];
  const updated: Array<string> = [];
  const unchanged: Array<string> = [];
  const collisions: Array<string> = [];
  const remove: Array<string> = [];
  for (const [skill, files] of [...shippedBySkill].sort(([a], [b]) => a.localeCompare(b))) {
    const current = installedBySkill.get(skill);
    if (current === undefined) added.push(skill);
    else if (!shared.includes(skill)) collisions.push(skill);
    else if (same(current, files)) unchanged.push(skill);
    else {
      updated.push(skill);
      for (const path of current.keys()) if (!files.has(path)) remove.push(path);
    }
  }
  const retired = shared.filter((skill) => !shippedBySkill.has(skill)).sort();
  const installing = new Set([...added, ...updated]);
  const write = new Map([...shipped].filter(([path]) => installing.has(skillOf(path))));
  const next = [...added, ...updated, ...unchanged].sort();
  if (installed.get(SKILLS_MANIFEST) === undefined || next.join("\n") !== shared.join("\n"))
    write.set(SKILLS_MANIFEST, manifest(next));
  return { added, updated, unchanged, retired, collisions, write, remove };
};

export const formatSync = (sync: SkillSync): string => {
  const changed = (
    [
      ["added", sync.added],
      ["updated", sync.updated],
      ["removed (no longer shipped)", sync.retired],
    ] as const
  ).filter(([, names]) => names.length > 0);
  return changed.length === 0
    ? `${SKILLS_DIR}: up to date (${sync.unchanged.length} shared)`
    : `${SKILLS_DIR}: ${changed.map(([what, names]) => `${what} ${names.join(", ")}`).join("; ")}`;
};

const collision = (name: string): string =>
  `is a skill of this repo's own, but monkeyshape now ships a shared skill named ${name}, so sync leaves yours alone and the shared one uninstalled. Rename yours: move ${SKILLS_DIR}/${name} and change \`name:\` in its SKILL.md, then run \`mshape skills sync\`.`;

/** What `mshape skills sync` prints about the skills it would not touch. */
export const formatCollisions = (sync: SkillSync): ReadonlyArray<string> =>
  sync.collisions.map((name) => `${SKILLS_DIR}/${name} ${collision(name)}`);

const violation = (rule: string, file: string, message: string): Violation => ({
  check: "skills",
  rule: `skills/${rule}`,
  file,
  message,
});

const RELINK = `\`rm -r ${CLAUDE_SKILLS_LINK} && mshape skills sync\``;

/** Whether git lists `path` or an entry above it: a symlinked skill is a single entry. */
const listed = (files: ReadonlySet<string>, path: string): boolean =>
  path.split("/").some((_, i, segments) => files.has(segments.slice(0, i + 1).join("/")));

const linkViolations = (snapshot: Snapshot, files: ReadonlySet<string>): Array<Violation> => {
  const { link, installed, claudeDirectory } = snapshot.skills;
  if (link.kind === "missing")
    return [
      violation(
        "link",
        CLAUDE_SKILLS_LINK,
        `is missing, so Claude Code can't see the skills in ${SKILLS_DIR}. Run \`mshape skills sync\` to create the link, and commit it.`,
      ),
    ];
  if (link.kind === "link") {
    if (link.target.startsWith("/"))
      return [
        violation(
          "link",
          CLAUDE_SKILLS_LINK,
          `links to the absolute path ${link.target}, which resolves only on this machine's checkout, not in other clones or worktrees. Replace it with the relative link: ${RELINK}.`,
        ),
      ];
    // `../.agents/skills/` and `./../.agents/skills` resolve the same; only where it lands counts.
    if (join(".claude", link.target) !== SKILLS_DIR)
      return [
        violation(
          "link",
          CLAUDE_SKILLS_LINK,
          `links to ${link.target}, not ${CLAUDE_SKILLS_TARGET}. Replace it: ${RELINK}.`,
        ),
      ];
    return files.has(CLAUDE_SKILLS_LINK)
      ? []
      : [
          violation(
            "untracked",
            CLAUDE_SKILLS_LINK,
            "is ignored by git, so clones and CI won't have it. If .gitignore has `.claude/`, change that line to `.claude/*` and add `!.claude/skills`; then `git add .claude/skills`.",
          ),
        ];
  }
  const out = [
    violation(
      "link",
      CLAUDE_SKILLS_LINK,
      `is a ${link.kind === "directory" ? "directory" : "file"}, not a link to ${CLAUDE_SKILLS_TARGET}, so Claude Code and other agents see different skills. The fix deletes it: first move or merge every skill in it into ${SKILLS_DIR}/, then ${RELINK}.`,
    ),
  ];
  const installedBySkill = bySkill(installed);
  for (const [name, copy] of bySkill(claudeDirectory)) {
    const twin = installedBySkill.get(name);
    if (twin === undefined)
      out.push(
        violation(
          "unlinked",
          `${CLAUDE_SKILLS_LINK}/${name}`,
          `is only in ${CLAUDE_SKILLS_LINK}, so agents other than Claude Code can't see it. Move it to ${SKILLS_DIR}/${name}.`,
        ),
      );
    else if (!same(twin, copy))
      out.push(
        violation(
          "diverged",
          `${CLAUDE_SKILLS_LINK}/${name}`,
          `differs from ${SKILLS_DIR}/${name}. Diff the two and keep what you need in ${SKILLS_DIR}/${name} before relinking, which deletes this copy.`,
        ),
      );
  }
  return out;
};

/**
 * The installed skills are what agents load, so they are checked, not trusted: the committed
 * link Claude Code reads through, committed skills with a SKILL.md each, and shared skills
 * matching the package. A repo with neither directory doesn't use skills, and passes.
 */
export const checkSkills = (
  _config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const { link, installed, shipped } = snapshot.skills;
  if (link.kind === "missing" && installed.size === 0) return [];
  const files = new Set(snapshot.files);
  const violations = linkViolations(snapshot, files);

  const ignored = new Set<string>();
  for (const path of installed.keys())
    if (!listed(files, `${SKILLS_DIR}/${path}`))
      ignored.add(`${SKILLS_DIR}/${path.includes("/") ? skillOf(path) : path}`);
  for (const path of [...ignored].sort())
    violations.push(
      violation(
        "untracked",
        path,
        "is ignored by git, so clones and CI won't have it. Remove the .gitignore rule that matches it (`git check-ignore -v <path>` names it), then `git add` it.",
      ),
    );

  for (const name of bySkill(installed).keys())
    if (!installed.has(`${name}/SKILL.md`))
      violations.push(
        violation(
          "skill-md",
          `${SKILLS_DIR}/${name}`,
          `has no SKILL.md, so no agent loads it. Add ${SKILLS_DIR}/${name}/SKILL.md, or delete the directory.`,
        ),
      );

  const manifestBytes = installed.get(SKILLS_MANIFEST);
  if (manifestBytes !== undefined && parseManifest(manifestBytes) === undefined)
    violations.push(
      violation(
        "manifest",
        `${SKILLS_DIR}/${SKILLS_MANIFEST}`,
        `is not the list \`mshape skills sync\` writes, so shared skills can't be told from this repo's own. Restore it with \`git checkout -- ${SKILLS_DIR}/${SKILLS_MANIFEST}\`.`,
      ),
    );

  const sync = syncSkills(shipped, installed);
  const due = (name: string, why: string) =>
    violations.push(
      violation(
        "sync-due",
        `${SKILLS_DIR}/${name}`,
        `${why} Run \`mshape skills sync\` and commit the result.`,
      ),
    );
  for (const name of sync.added)
    due(name, "is a shared skill monkeyshape ships but this repo hasn't installed.");
  for (const name of sync.updated)
    due(
      name,
      "differs from the shared skill the installed monkeyshape ships; to change a shared skill locally, copy it under a name of your own.",
    );
  for (const name of sync.retired)
    due(
      name,
      "is a shared skill monkeyshape no longer ships, so sync removes it; to keep it, copy it under a name of your own first.",
    );
  for (const name of sync.collisions)
    violations.push(violation("collision", `${SKILLS_DIR}/${name}`, collision(name)));
  return violations;
};
