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

export * from './types.js';
export { parseSkillFile, stringifySkillFile, validateSkillName } from './parse.js';
export { discoverSkills, skillPath, type SkillsVfs, type DiscoverOpts } from './discover.js';
export { BUILTIN_SKILLS } from './builtins.js';
export {
  resolveActiveSkills,
  extractExplicitInvocations,
  type LoadActiveSkillsOpts,
} from './loader.js';
export {
  renderActiveSkillsSection,
  renderSkillsIndexSection,
  unionAllowedTools,
  toolAllowedBySkills,
  ACTIVE_SKILLS_MAX_CHARS,
  SKILLS_INDEX_MAX_CHARS,
} from './render.js';
