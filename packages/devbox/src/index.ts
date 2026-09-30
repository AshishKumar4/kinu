/** Export a type only when a caller must write its name. */

export { Devbox, type DevboxState } from './devbox';

export { DevboxError, devboxFailure, type DevboxErrorCode } from './errors';

export { DevboxSyncGateway, DevboxOutbound, type OutboundPolicy } from './gateway';

export { DevboxStoreGateway } from './store-gateway';

export type { RestoreClockPhase, RestoreStatus } from './restoration';

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
