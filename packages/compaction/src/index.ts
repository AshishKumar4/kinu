/** @kinu.run/compaction: the better-compact ladder, Kinu codec, extension, archive manifest and storage ports. */

export { type Logger } from '@better-compact/core';

export { kinuCodec, kinuConventions, kinuSpec } from './codec';

export { type AttachmentDeps } from './attachments';

export {
  createActorCompaction,
  hostedActorCompaction,
  compactionDiagnostics,
  type ActorCompactionDeps,
} from './actor';

export {
  createCompactionExtension,
  type CompactionExtension,
  type CompactionExtensionDeps,
  type CompactionOutcomeEvent,
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
