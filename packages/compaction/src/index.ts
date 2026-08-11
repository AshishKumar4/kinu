/**
 * @proteus/compaction — the staged context-pruning compaction engine.
 *
 * One deep module: the published better-compact ladder core, the Proteus
 * ModelMessage codec, the
 * `createCompactionExtension` factory whose `transformContext` runs the
 * ladder, the archive manifest that makes its citable transcripts navigable
 * (manifest.ts), and the real ports over the shared storage primitives
 * (stores.ts: VFS transcript store + durable SQL compaction state). Backends inject the
 * genuinely backend-specific pieces (summarizer transport, logger, onOutcome)
 * and register the extension; nothing here touches a backend.
 */

export * from '@better-compact/core';
export { proteusCodec, proteusConventions, proteusSpec, type ToolPairHandle } from './codec.js';
export {
  createCompactionExtension,
  type CompactionExtensionDeps,
  type CompactionOutcomeEvent,
} from './extension.js';
export {
  deriveArchiveRange,
  renderArchiveManifest,
  withArchiveManifest,
  type ArchiveIndexStore,
  type ArchiveRange,
} from './manifest.js';
export {
  compactionTranscriptPath,
  createVfsTranscriptStore,
  createCompactionStateStore,
  type CompactionStateStore,
} from './stores.js';
export { createModelSummarizer, SUMMARIZER_TIMEOUT_MS } from './summarizer.js';
// The compaction-ladder layer-gate slice (core declares the layer; this
// package measures it — see scripts/layergate.ts for the merged report).
export {
  COMPACTION_LAYERS, COMPACTION_FAULTS, createCompactionLadderSubjects,
  type CompactionLadderSubjects,
} from './layergate.js';
export { COMPACTION_LOCKED_BASELINE } from './layergate-baseline.js';
