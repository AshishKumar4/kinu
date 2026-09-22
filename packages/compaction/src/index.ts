/** @kinu.run/compaction: the better-compact ladder, Kinu codec, extension, archive manifest and storage ports. */

export * from '@better-compact/core';

export { kinuCodec, kinuConventions, kinuSpec, type ToolPairHandle } from './codec';

export {
  createCompactionExtension,
  createSharedPrefixCompactor,
  type CompactionExtensionDeps,
  type CompactionOutcomeEvent,
  type SharedPrefixCompactorDeps,
} from './extension';

export {
  deriveArchiveRange,
  renderArchiveManifest,
  withArchiveManifest,
  type ArchiveIndexStore,
  type ArchiveRange,
} from './manifest';

export {
  compactionTranscriptPath,
  createVfsTranscriptStore,
  createCompactionStateStore,
  type CompactionStateStore,
} from './stores';

export { createModelSummarizer } from './summarizer';

// Compaction-ladder layer-gate slice; see scripts/layergate.ts for the merged report.
export {
  COMPACTION_LAYERS, COMPACTION_FAULTS, createCompactionLadderSubjects,
  type CompactionLadderSubjects,
} from './layergate';

export { COMPACTION_LOCKED_BASELINE } from './layergate-baseline';
