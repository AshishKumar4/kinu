/**
 * The capture module: soundness model, three candidate mechanisms, and the
 * capability decision that picks between them. Nothing here is wired into the
 * product; this is the evidence package for which CaptureSound mechanism a
 * native writable upper can honestly support.
 */

export {
  auditCapture,
  canonicalManifestBytes,
  contentEquals,
  contentExtents,
  contentSize,
  expandContent,
  manifestSha256,
  prefixState,
  stateEquals,
  requireCompleteCaptureTree,
  toCapturedCut,
  requireAuditedCapture,
  issueVerifiedJournalCapture,
  AuditedCapture,
  MutationLog,
  readCaptureRange,
  MAX_SEALED_EXTENT_BYTES,
} from './model';
export type {
  CapturedCutIdentity,
  Capture,
  CaptureAudit,
  FileContent,
  LiveNode,
  LogEntry,
  MutationOp,
  NodeEntry,
  NodeKind,
  SealedContent,
  SealedContentReader,
  SealedExtent,
  SparseRun,
  StateSnapshot,
  UpperPath,
  VerifiedJournalCut,
} from './model';


export { logView } from './view';
export type { CaptureView } from './view';

export { naiveLiveScan, stableScan } from './stable-scan';
export type { StableScanOptions, StableScanResult } from './stable-scan';
export { captureFrozenCopy, logFreezeSeam } from './freeze-drain';
export type {
  ContainerCaptureDaemon,
  FreezeSeam,
  FrozenCaptureOptions,
  FrozenCaptureResult,
  SyncMethod,
} from './freeze-drain';

export { materializeJournalPrefix, WatchEventQueue } from './journal-capture';
export type {
  JournalBatch,
  JournalCaptureResult,
  JournalSource,
} from './journal-capture';

export {
  CAPTURE_CAPABILITIES,
  CAPTURE_NO_GO_REASONS,
  CAPTURE_CHECK_STATUSES,
  CaptureCapabilityReportSchema,
  CapabilityCheckSchema,
  decideCaptureMechanism,
} from './capabilities';
export type {
  CaptureCapabilityId,
  CaptureCapabilityReport,
  CaptureCheckStatus,
  CaptureMechanismDecision,
  CaptureNoGoReason,
  CapabilityCheck,
} from './capabilities';
