/** Export a type only when a caller must write its name. */

export { Devbox, type DevboxState } from './devbox';

export { type SessionRecord, type TerminalSession } from './sessions';

export { GOLDEN_NAME } from './golden';

export { DevboxError, devboxFailure, type DevboxErrorCode } from './errors';

export { execRecords, readExec } from './exec-stream';

export { DevboxGateway, type OutboundPolicy } from './gateway';

export { previewBox } from './preview';

export type { RestoreClockPhase, RestoreStatus } from './restoration';

export { holdReadiness } from './readiness-hold';

export { BoxSizeSchema, type BoxSize } from './sizes';

export type { CheckpointKind, CheckpointOutcome } from './storage';

export { describeThrown } from './lifecycle';

export type { DevboxIncident, DevboxPolicy, IncidentDisposition, IncidentStage } from './lifecycle';
