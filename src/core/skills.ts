/**
 * Shared skills: the package's `skills/<name>/` copied into a repo's `.agents/skills/<name>/`,
 * which Claude Code reaches through the committed relative link `.claude/skills`
 * (D-skills-link). A skill whose name the package doesn't ship is the repo's own and is never
 * touched; a shared skill is replaced whole, so a file the package dropped goes too.
 */
import type { ResolvedConfig } from "../schemas/config.ts";
import type { SkillFiles, Snapshot, Violation } from "./model.ts";

export const SKILLS_DIR = ".agents/skills";
export const CLAUDE_SKILLS_LINK = ".claude/skills";
/** The link's text, relative to `.claude/`: it resolves in every clone and worktree. */
export const CLAUDE_SKILLS_TARGET = "../.agents/skills";

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

const violation = (rule: string, file: string, message: string): Violation => ({
  check: "skills",
  rule: `skills/${rule}`,
  file,
  message,
});

const names = (files: SkillFiles): ReadonlySet<string> => new Set(byskill(files).keys());

const RELINK = `\`rm -r ${CLAUDE_SKILLS_LINK} && mshape skills sync\``;

/**
 * The installed skills are what agents load, so they are checked, not trusted: the link
 * Claude Code reads through, a SKILL.md in every skill, and shared skills matching the
 * package. A repo with neither directory doesn't use skills, and passes.
 */
export const checkSkills = (
  _config: ResolvedConfig,
  snapshot: Snapshot,
): ReadonlyArray<Violation> => {
  const { link, installed, claudeDirectory, shipped } = snapshot.skills;
  if (link.kind === "missing" && installed.size === 0) return [];
  const violations: Array<Violation> = [];
  const installedNames = names(installed);

  if (link.kind === "missing")
    violations.push(
      violation(
        "link",
        CLAUDE_SKILLS_LINK,
        `is missing, so Claude Code can't see the skills in ${SKILLS_DIR}. Run \`mshape skills sync\` to create the link, and commit it.`,
      ),
    );
  else if (link.kind === "link" && link.target !== CLAUDE_SKILLS_TARGET)
    violations.push(
      violation(
        "link",
        CLAUDE_SKILLS_LINK,
        link.target.startsWith("/")
          ? `links to the absolute path ${link.target}, which resolves only on this machine's checkout, not in other clones or worktrees. Replace it with the relative link: ${RELINK}.`
          : `links to ${link.target}, not ${CLAUDE_SKILLS_TARGET}. Replace it: ${RELINK}.`,
      ),
    );
  else if (link.kind === "directory" || link.kind === "other") {
    violations.push(
      violation(
        "link",
        CLAUDE_SKILLS_LINK,
        `is a ${link.kind === "directory" ? "directory" : "file"}, not a link to ${CLAUDE_SKILLS_TARGET}, so Claude Code and other agents see different skills. Move any skill of your own into ${SKILLS_DIR}/, then ${RELINK}.`,
      ),
    );
    for (const name of names(claudeDirectory))
      if (!installedNames.has(name))
        violations.push(
          violation(
            "unlinked",
            `${CLAUDE_SKILLS_LINK}/${name}`,
            `is only in ${CLAUDE_SKILLS_LINK}, so agents other than Claude Code can't see it. Move it to ${SKILLS_DIR}/${name}.`,
          ),
        );
  }

  for (const name of installedNames)
    if (!installed.has(`${name}/SKILL.md`))
      violations.push(
        violation(
          "skill-md",
          `${SKILLS_DIR}/${name}`,
          `has no SKILL.md, so no agent loads it. Add ${SKILLS_DIR}/${name}/SKILL.md, or delete the directory.`,
        ),
      );

  const sync = syncSkills(shipped, installed);
  for (const name of sync.added)
    violations.push(
      violation(
        "sync-due",
        `${SKILLS_DIR}/${name}`,
        "is a shared skill monkeyshape ships but this repo hasn't installed. Run `mshape skills sync` and commit the result.",
      ),
    );
  for (const name of sync.updated)
    violations.push(
      violation(
        "sync-due",
        `${SKILLS_DIR}/${name}`,
        "differs from the shared skill the installed monkeyshape ships. Run `mshape skills sync` and commit the result; to change a shared skill locally, copy it under a name of your own.",
      ),
    );
  return violations;
};
