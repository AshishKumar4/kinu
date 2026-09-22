// Cross-workspace experience transfer (Agent-KB, arXiv:2507.06229): imports are misevolution-gated
// and stay provisional until the importing workspace's own evidence corroborates them.

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
