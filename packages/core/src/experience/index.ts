/**
 * Cross-workspace experience transfer (Agent-KB, arXiv:2507.06229): the owner's
 * workspaces share crafts, lessons and facts through one owner-scoped library,
 * with every import gated by the misevolution checker and staged provisional
 * until the importing workspace's own turn outcome corroborates it.
 */

export {
  EXPERIENCE_KINDS,
  describePayload,
  experienceSearchText,
  misevolutionSourceOf,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperiencePayload,
  type PublishableCandidate,
} from './types.js';

export {
  createExperienceLibrary,
  initExperienceLibraryTables,
  type ExperienceLibraryStore,
  type ExperienceSearchOptions,
} from './library.js';

export {
  EXPERIENCE_MIN_FACT_CONFIDENCE,
  findPublishable,
  listPublishable,
  type PublishRefusal,
  type PublishSources,
} from './publishable.js';

export {
  bindPendingImports,
  initImportedExperienceTable,
  listImportedExperience,
  settleImportsForTurn,
  stageImport,
  type ImportOutcome,
  type ImportSettlement,
  type ImportStatus,
  type ImportedExperienceRow,
} from './imports.js';

export {
  EXPERIENCE_ACTIONS,
  runExperienceAction,
  type ExperienceAction,
  type ExperienceActionDeps,
  type ExperienceActionInput,
  type ExperienceLibraryClient,
} from './actions.js';
