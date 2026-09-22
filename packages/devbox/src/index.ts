/** Public surface of @kinu.run/devbox; durability contracts live only at their own subpath.
 *  Export a type only when a caller must write its name; structural reads need no export. */

export { Devbox } from './devbox';

export type { RestoreClockPhase } from './devbox';

export {
  ATTACH_OUTCOME_KINDS,
  CHECKPOINT_OUTCOME_KINDS,
  DEFAULT_DEVBOX_STRATEGY,
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
  archiveCommand,
  archiveExcludeFile,
  archiveSizeCommand,
  baseObjectKey,
  chainBackupOptions,
  CHAIN_EXCLUDES,
  EXTRACT_TTL_SECONDS,
  deltaObjectKey,
  isChainId,
  layerIntegrityFailure,
  metadataObjectKey,
  normalizeArchiveExclude,
  normalizeChainState,
  REBASE_DELTA_RATIO,
  shouldRebase,
  snapshotChainStorage,
  supersedeGeneration,
} from './snapshot-chain';

export type {
  ChainGeneration,
  ChainState,
  ChangeStatus,
  SnapshotChainPorts,
} from './snapshot-chain';

export { INCIDENT_REASON_MAX_CHARS } from './incidents';
