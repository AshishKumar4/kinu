/**
 * Skills barrel. Claude-Code SKILL.md compatible; skills are ordinary files under
 * /workspace/skills/ with no dedicated LLM tool.
 */

export * from './types';

export {
  parseSkillFile, stringifySkillFile, skillNameProblem,
} from './parse';

export {
  discoverSkills, readSkillFile, readSkillBody, skillPath, compareSkillNames,
  BUILTIN_SKILL_HEADERS, BUILTIN_SKILL_NAMES, SKILL_FOLDER_FILE,
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

export {
  normalizeDrivePath, listDrive, makeDriveFolder, renameDriveEntry,
  deleteDriveEntry, markAsSkill, addSkill, receiveDriveUpload, packDriveFolder, driveFailure,
  DriveListingSchema, MarkedSkillSchema, DriveUploadTargetSchema,
  type DriveEntry, type DriveListing, type MarkedSkill, type DriveFailure, type DriveUploadTarget, type DriveUploadOutcome,
} from './drive';
