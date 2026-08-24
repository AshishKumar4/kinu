/**
 * @kinu.run/compaction — the staged context-pruning compaction engine.
 *
 * One deep module: the published better-compact ladder core, the Kinu
 * ModelMessage codec, the
 * `createCompactionExtension` factory whose `transformContext` runs the
 * ladder, the archive manifest that makes its citable transcripts navigable
 * (manifest.ts), and the real ports over the shared storage primitives
 * (stores.ts: VFS transcript store + durable SQL compaction state). Backends inject the
 * genuinely backend-specific pieces (summarizer transport, logger, onOutcome)
 * and register the extension; nothing here touches a backend.
 */

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
// The compaction-ladder layer-gate slice (core declares the layer; this
// package measures it — see scripts/layergate.ts for the merged report).
export {
  COMPACTION_LAYERS, COMPACTION_FAULTS, createCompactionLadderSubjects,
  type CompactionLadderSubjects,
} from './layergate';
export { COMPACTION_LOCKED_BASELINE } from './layergate-baseline';
