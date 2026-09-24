/** Export a type only when a caller must write its name. */

export { Devbox, devboxSyncHandlers } from './devbox';

export type { RestoreClockPhase } from './devbox';

export { DEFAULT_DEVBOX_STRATEGY, parseDevboxStrategyName } from './storage';

export type {
  AttachOutcome,
  CheckpointKind,
  CheckpointOutcome,
  DevboxStorage,
  DevboxStore,
  DevboxStrategyName,
} from './storage';

export { describeThrown } from './lifecycle';

export type { DevboxIncident, DevboxPolicy, IncidentDisposition, IncidentStage } from './lifecycle';
