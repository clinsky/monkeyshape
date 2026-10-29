/**
 * Shared skills: the package's `skills/<name>/` copied into a repo's `.agents/skills/<name>/`,
 * which Claude Code reaches through the committed relative link `.claude/skills`
 * (D-skills-link). A skill whose name the package doesn't ship is the repo's own and is never
 * touched; a shared skill is replaced whole, so a file the package dropped goes too.
 */

export const SKILLS_DIR = ".agents/skills";
export const CLAUDE_SKILLS_LINK = ".claude/skills";
/** The link's text, relative to `.claude/`: it resolves in every clone and worktree. */
export const CLAUDE_SKILLS_TARGET = "../.agents/skills";

/** Files keyed by path relative to the skills directory: `<skill>/SKILL.md`. */
export type SkillFiles = ReadonlyMap<string, string>;

export interface SkillSync {
  readonly added: ReadonlyArray<string>;
  readonly updated: ReadonlyArray<string>;
  readonly unchanged: ReadonlyArray<string>;
  /** The files `.agents/skills` should hold for the shared skills afterwards. */
  readonly write: SkillFiles;
  /** Installed files of shared skills that the package no longer has. */
  readonly remove: ReadonlyArray<string>;
}

const skillOf = (path: string): string => path.slice(0, path.indexOf("/"));

const byskill = (files: SkillFiles): ReadonlyMap<string, SkillFiles> => {
  const out = new Map<string, Map<string, string>>();
  for (const [path, text] of files) {
    if (!path.includes("/")) continue;
    const skill = skillOf(path);
    out.set(skill, (out.get(skill) ?? new Map()).set(path, text));
  }
  return out;
};

const same = (a: SkillFiles | undefined, b: SkillFiles): boolean =>
  a !== undefined && a.size === b.size && [...b].every(([path, text]) => a.get(path) === text);

/** What it takes to bring the installed shared skills up to the package's. */
export const syncSkills = (shipped: SkillFiles, installed: SkillFiles): SkillSync => {
  const installedBySkill = byskill(installed);
  const added: Array<string> = [];
  const updated: Array<string> = [];
  const unchanged: Array<string> = [];
  const remove: Array<string> = [];
  for (const [skill, files] of [...byskill(shipped)].sort(([a], [b]) => a.localeCompare(b))) {
    const current = installedBySkill.get(skill);
    if (current === undefined) added.push(skill);
    else if (same(current, files)) unchanged.push(skill);
    else {
      updated.push(skill);
      for (const path of current.keys()) if (!files.has(path)) remove.push(path);
    }
  }
  const write = new Map(
    [...shipped].filter(([path]) => path.includes("/") && !unchanged.includes(skillOf(path))),
  );
  return { added, updated, unchanged, write, remove };
};

export const formatSync = (sync: SkillSync): string => {
  const parts = [
    ["added", sync.added],
    ["updated", sync.updated],
  ] as const;
  const changed = parts.filter(([, names]) => names.length > 0);
  if (changed.length === 0) return `${SKILLS_DIR}: up to date (${sync.unchanged.length} shared)`;
  return `${SKILLS_DIR}: ${changed.map(([what, names]) => `${what} ${names.join(", ")}`).join("; ")}`;
};
