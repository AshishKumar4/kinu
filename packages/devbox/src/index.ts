/**
 * @kinu.run/devbox — a machine that stays, on a container that does not.
 *
 * The whole public surface. Nothing is exported for symmetry: every name below
 * is imported by name somewhere, by the class, the bench app, or a test that
 * pins a decision. The frozen durability contracts are NOT re-exported here —
 * `@kinu.run/devbox/durability/contracts` is their one path, because the
 * instruments that validate against them are not consumers of this class.
 *
 * Types that only appear as a consumed function's parameter or return type are
 * deliberately absent. A caller reads them structurally, and re-exporting a
 * name nobody writes is surface that nothing keeps honest. Add one here when a
 * caller needs to write it, together with that caller.
 */

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
