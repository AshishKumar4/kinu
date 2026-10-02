/** Export a type only when a caller must write its name. */

export { Devbox, type DevboxState, type PortListener } from './devbox';

export { DevboxError, devboxFailure, type DevboxErrorCode } from './errors';

export { collectExecRecords, execRecords } from './exec-stream';

export { DevboxOutbound, type OutboundPolicy } from './gateway';

export { DevboxStoreGateway } from './store-gateway';

export type { RestoreClockPhase, RestoreStatus } from './restoration';

export { BOX_SIZES, BOX_SIZE_ORDER, BoxSizeSchema, DEFAULT_BOX_SIZE, type BoxSize, type ResizeOutcome } from './sizes';

export type {
  AttachOutcome,
  CheckpointKind,
  CheckpointOutcome,
  DevboxStorage,
  DevboxStore,
} from './storage';

export { describeThrown } from './lifecycle';

export type { DevboxIncident, DevboxPolicy, IncidentDisposition, IncidentStage } from './lifecycle';
