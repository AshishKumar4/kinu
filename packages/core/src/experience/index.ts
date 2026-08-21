/**
 * Cross-workspace experience transfer (Agent-KB, arXiv:2507.06229): the owner's
 * workspaces share crafts, lessons, facts and promoted scaffolds through one
 * owner-scoped library, with every import gated by the misevolution checker and
 * staged provisional until the importing workspace's own evidence — a turn
 * outcome, or for a scaffold its own shadow trial — corroborates it.
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
} from './types';

export {
  createExperienceLibrary,
  initExperienceLibraryTables,
  type ExperienceLibraryStore,
  type ExperienceSearchOptions,
} from './library';

export {
  EXPERIENCE_MIN_FACT_CONFIDENCE,
  findPublishable,
  listPublishable,
  type PublishRefusal,
  type PublishSources,
} from './publishable';

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
} from './imports';

export {
  EXPERIENCE_ACTIONS,
  runExperienceAction,
  type ExperienceAction,
  type ExperienceActionDeps,
  type ExperienceActionInput,
  type ExperienceLibraryClient,
} from './actions';
