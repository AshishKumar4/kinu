/**
 * @proteus/compaction — the staged context-pruning compaction engine.
 *
 * One deep module: the vendored better-compact ladder core (src/engine/,
 * provenance in PROVENANCE.md), the Proteus ModelMessage codec, the
 * `createCompactionExtension` factory whose `transformContext` runs the
 * ladder, and the real ports over the shared storage primitives (stores.ts:
 * VFS transcript store + durable SQL compaction state). Backends inject the
 * genuinely backend-specific pieces (summarizer transport, logger, onOutcome)
 * and register the extension; nothing here touches a backend.
 */

export * from './engine/index.js';
export { proteusCodec, proteusConventions, proteusSpec, type ToolPairHandle } from './codec.js';
export {
  createCompactionExtension,
  type CompactionExtensionDeps,
  type CompactionOutcomeEvent,
} from './extension.js';
export {
  compactionTranscriptPath,
  createVfsTranscriptStore,
  initCompactionStateTable,
  createCompactionStateStore,
  type CompactionStateStore,
} from './stores.js';
export { createModelSummarizer, SUMMARIZER_TIMEOUT_MS } from './summarizer.js';
