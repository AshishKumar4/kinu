/**
 * Skills barrel. Claude-Code SKILL.md compatible; every skill is an ordinary file under `/skills`.
 */

export * from './types';

export {
  parseSkillFile, stringifySkillFile, skillNameProblem,
} from './parse';

export {
  discoverSkills, readSkillFile, readSkillBody, workspaceSkillPath, compareSkillNames,
  BUILTIN_SKILL_HEADERS, BUILTIN_SKILL_NAMES,
  type SkillsVfs, type DiscoverOpts, type SkillsDiscovery, type UnreadSkillFile,
} from './discover';

export { BUILTIN_SKILLS, BUILTIN_SKILL_FILES } from './builtins';

export { skillsMount } from './view';

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
