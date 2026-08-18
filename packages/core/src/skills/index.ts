/**
 * Skills barrel.
 *
 * Public surface:
 *
 *   - types:    `ParsedSkill`, `ActiveSkillSet`, …
 *   - parse:    `parseSkillFile`, `stringifySkillFile`, `validateSkillName`
 *   - discover: `discoverSkills`, `skillPath`, `SkillsVfs`, `BUILTIN_SKILLS`
 *   - loader:   `resolveActiveSkills`, `extractExplicitInvocations`
 *   - render:   `renderActiveSkillsSection` (active bodies),
 *               `renderSkillsIndexSection` (ambient name+description index),
 *               `unionAllowedTools`, `toolAllowedBySkills`
 *
 * Claude-Code SKILL.md compatible. No LLM-facing tool and no codemode
 * namespace: skills are ordinary files under /workspace/skills/, reachable
 * via workspace.readFile/writeFile/readdir/exec in execute_tools.
 */

export * from './types';
export { parseSkillFile, stringifySkillFile, validateSkillName } from './parse';
export { discoverSkills, skillPath, type SkillsVfs, type DiscoverOpts } from './discover';
export { BUILTIN_SKILLS } from './builtins';
export {
  resolveActiveSkills,
  extractExplicitInvocations,
  type LoadActiveSkillsOpts,
} from './loader';
export {
  renderActiveSkillsSection,
  renderSkillsIndexSection,
  unionAllowedTools,
  toolAllowedBySkills,
  ACTIVE_SKILLS_MAX_CHARS,
  SKILLS_INDEX_MAX_CHARS,
} from './render';
