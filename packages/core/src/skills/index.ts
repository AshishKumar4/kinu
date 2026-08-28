/**
 * Skills barrel.
 *
 * Public surface:
 *
 *   - types:    `SkillHeader`, `DiscoveredSkill`, `ActiveSkill`, `SkillsIndex`, …
 *   - parse:    `parseSkillFile`, `stringifySkillFile`, `validateSkillName`,
 *               `skillNameProblem`
 *   - discover: `discoverSkills` (headers only — no body is read), `skillPath`,
 *               `readSkillBody`, `compareSkillNames`, `SkillsVfs`,
 *               `BUILTIN_SKILLS`, `BUILTIN_SKILL_HEADERS`
 *   - loader:   `resolveActiveSkills`, `extractExplicitInvocations`,
 *               `admitSkillsIndex` + `admitActiveSkills` (the model-window
 *               admission both prompt sections are spent out of)
 *   - render:   `renderActiveSkillsSection` (active bodies),
 *               `renderSkillsIndexSection` (ambient name+description index),
 *               `unionAllowedTools`, `toolAllowedBySkills`
 *
 * Claude-Code SKILL.md compatible. No LLM-facing tool and no codemode
 * namespace: skills are ordinary files under /workspace/skills/, reachable
 * via workspace.readFile/writeFile/readdir/exec in execute_tools.
 */

export * from './types';
export {
  parseSkillFile, stringifySkillFile, validateSkillName, skillNameProblem,
} from './parse';
export {
  discoverSkills, readSkillFile, readSkillBody, skillPath, compareSkillNames,
  BUILTIN_SKILL_HEADERS, BUILTIN_SKILL_NAMES,
  type SkillsVfs, type DiscoverOpts, type SkillsDiscovery, type UnreadSkillFile,
} from './discover';
export { BUILTIN_SKILLS } from './builtins';
export {
  resolveActiveSkills,
  extractExplicitInvocations,
  admitSkillsIndex,
  admitActiveSkills,
  type LoadActiveSkillsOpts,
  type ActivatedSkill,
} from './loader';
export {
  renderActiveSkillsSection,
  renderSkillsIndexSection,
  skillIndexLine,
  unreadSkillLine,
  unionAllowedTools,
  toolAllowedBySkills,
  trustedActiveSkills,
} from './render';
