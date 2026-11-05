// Cross-workspace experience transfer (Agent-KB, arXiv:2507.06229): imports are misevolution-gated
// and stay provisional until the importing workspace's own evidence corroborates them.

export {
  EXPERIENCE_KINDS,
  parseExperiencePayload,
  type ExperienceEntry,
  type ExperienceKind,
  type ExperiencePayload,
} from './types';

export {
  createExperienceLibrary,
  initExperienceLibraryTables,
  type ExperienceLibraryStore,
  type ExperienceSearchOptions,
} from './library';


