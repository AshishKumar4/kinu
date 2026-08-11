/**
 * Skills barrel.
 *
 * Public surface:
 *
 *   - types:    `ParsedSkill`, `SkillsAction`, `ActiveSkillSet`, …
 *   - parse:    `parseSkillFile`, `stringifySkillFile`, `validateSkillName`
 *   - discover: `discoverSkills`, `skillPath`, `SkillsVfs`, `BUILTIN_SKILLS`
 *   - loader:   `resolveActiveSkills`, `extractExplicitInvocations`
 *   - render:   `renderActiveSkillsSection`, `unionAllowedTools`,
 *               `toolAllowedBySkills`
 *   - tool:     `runSkillsAction`, `SkillsToolDeps`, `SkillsToolOutcome`
 *
 * Claude-Code SKILL.md compatible.
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
  unionAllowedTools,
  toolAllowedBySkills,
  ACTIVE_SKILLS_MAX_CHARS,
} from './render.js';
export {
  runSkillsAction,
  type SkillsToolDeps,
  type SkillsToolOutcome,
} from './tool.js';
