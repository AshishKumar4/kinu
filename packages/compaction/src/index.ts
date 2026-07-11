/**
 * @proteus/compaction — the staged context-pruning compaction engine.
 *
 * One deep module: the vendored better-compact ladder core (src/engine/,
 * provenance in PROVENANCE.md), the Proteus ModelMessage codec, and the
 * `createCompactionExtension` factory whose `transformContext` runs the
 * ladder. Backends inject ports (transcripts/plans/logger/summarize) and
 * register the extension; nothing here touches a backend.
 */

export * from './engine/index.js';
export { proteusCodec, proteusConventions, proteusSpec, type ToolPairHandle } from './codec.js';
export {
  createCompactionExtension,
  type CompactionExtensionDeps,
  type CompactionOutcomeEvent,
} from './extension.js';
