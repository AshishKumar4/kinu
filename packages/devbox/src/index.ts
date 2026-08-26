/**
 * @kinu.run/devbox — a machine that stays, on a container that does not.
 *
 * The whole public surface. Nothing is exported for symmetry: every name below
 * is imported by name somewhere, by the class, a strategy, the bench app, or a
 * test that pins a decision.
 *
 * Types that only appear as a consumed function's parameter or return type are
 * deliberately absent. A caller reads them structurally, and re-exporting a
 * name nobody writes is surface that nothing keeps honest. Add one here when a
 * caller needs to write it, together with that caller.
 */

export { Devbox } from './devbox';

export {
  ATTACH_OUTCOME_KINDS,
  CHECKPOINT_OUTCOME_KINDS,
  DEVBOX_RUNTIME_DIR,
  DEVBOX_WORKDIR,
  parseDevboxStrategyName,
} from './storage';
export type {
  AttachOutcome,
  CheckpointKind,
  CheckpointOutcome,
  DevboxStorage,
  DevboxStore,
  DevboxStrategyName,
} from './storage';

export {
  DEFAULT_DEVBOX_POLICY,
  describeThrown,
  findMount,
  generatePortToken,
  healthProbeCommand,
  healthProbeSilent,
  incidentRetryDelayMs,
  INCIDENT_STAGES,
  needsArming,
  PORT_TOKEN_ALPHABET,
  quiesceStep,
  restartPlan,
  withContainerStartDeadline,
} from './lifecycle';
export type {
  DevboxIncident,
  DevboxPolicy,
  IncidentDisposition,
  IncidentStage,
  PortExposureSpec,
  SupervisedProcessSpec,
} from './lifecycle';

export {
  assertChainId,
  baseObjectKey,
  chainBackupOptions,
  CHAIN_EXCLUDES,
  CHAIN_STORE_MOUNT,
  EXTRACT_TTL_SECONDS,
  deltaObjectKey,
  isChainId,
  layerIntegrityFailure,
  metadataObjectKey,
  normalizeChainState,
  isOverlayMounted,
  REBASE_DELTA_RATIO,
  shouldRebase,
  shouldCheckpoint,
  snapshotChainStorage,
} from './snapshot-chain';
export type {
  ChainState,
  ChangeStatus,
  SnapshotChainPorts,
} from './snapshot-chain';

export { INCIDENT_REASON_MAX_CHARS } from './incidents';

export {
  isS3fsMounted,
  R2FS_CACHE_DIR,
  R2FS_S3FS_OPTIONS,
  r2fsStorage,
} from './r2fs';
export type { R2fsPorts } from './r2fs';

export {
  CAS_TREE_MOUNT,
  normalizeOverlayCasState,
  overlayCasStorage,
  advanceCursor,
  foldJournalIntoTree,
  replayPending,
  stageBlobs,
} from './overlay-cas';
export type {
  OverlayCasPorts,
  OverlayCasState,
  UpperSignature,
} from './overlay-cas';

export {
  DURABILITY_AWAIT_POINTS,
  CapturedCutSchema,
  DURABILITY_OPERATION_KINDS,
  DURABILITY_OPERATION_PHASES,
  DURABLE_ROOT_FORMATS,
  ImmutableObjectRefSchema,
  HeadPointerV1Schema,
  ObjectReceiptSchema,
  OperationRecordSchema,
  PayloadGrantSchema,
  RangeReadIntentSchema,
  RestoreWorkSchema,
  RootEnvelopeV1Schema,
  UploadIntentSchema,
} from './durability/contracts';
export type {
  DurabilityAwaitPoint,
  CapturedCut,
  HeadPointerV1,
  ImmutableObjectRef,
  ObjectReceipt,
  OperationRecord,
  PayloadGrant,
  RangeReadIntent,
  RestoreWork,
  RootEnvelopeV1,
  UploadIntent,
} from './durability/contracts';
