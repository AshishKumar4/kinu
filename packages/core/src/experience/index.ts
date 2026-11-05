// Cross-workspace experience transfer (Agent-KB, arXiv:2507.06229): imports are misevolution-gated
// and stay provisional until the importing workspace's own evidence corroborates them.

export {
  EXPERIENCE_KINDS,
  experienceSearchText,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperiencePayload,
  type PublishableCandidate,
} from './types';

export {
  createExperienceLibrary,
  initExperienceLibraryTables,
  type ExperienceLibraryStore,
  type ExperienceSearchOptions,
} from './library';

export {
  bindPendingImports,
  initImportedExperienceTable,
  listImportedExperience,
  settleImportsForTurn,
  type ImportSettlement,
  type ImportedExperienceRow,
} from './imports';

