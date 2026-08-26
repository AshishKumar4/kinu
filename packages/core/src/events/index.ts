/**
 * Run events — public surface.
 */

export type {
  RunEvent,
  RunEventBase,
  RunEventInput,
  RunEventType,
  CompletionGateRecord,
  DelegationOpportunityRecord,
  DelegationSurface,
  TurnSteeringRecord,
  TurnSteeringTrigger,
  CraftCycleRecord,
  ApprovalConsumedRecord,
  ExecutionRecoveryRecord,
  StepCost,
} from './types';

export { FAILURE_WITHOUT_ERROR } from './types';

export {
  initRunEventTables,
  parseStoredRunEvent,
  RunEventSchema,
  recordModelOperations,
  RunEventRecorder,
  type RunEventListener,
  type RunEventQuery,
} from './recorder';

export {
  cacheHitRate,
  summarizeSteps,
  CACHE_HIT_EMA_ALPHA,
  type CacheHitStats,
  type StepTelemetry,
} from './step-stats';

export {
  scheduledOutbox,
  type Outbox,
  type OutboxDeadLetter,
  type OutboxDisposition,
  type OutboxDrainResult,
  type OutboxRecord,
  type ScheduledOutboxPolicy,
} from './outbox';

export {
  SPEND_SOURCES,
  SPEND_SOURCE_LABEL,
  SPEND_SOURCE_DETAIL,
  WORKSPACE_RUN_ID,
  MODEL_OPERATION_KINDS,
  MODEL_OPERATION_PHASES,
  MODEL_OPERATION_OUTCOMES,
  beginModelOperation,
  // buildModelCallEvent lives in a sibling module — see its header for why the
  // pricing edge cannot sit in model-call.ts.
  type ModelCallReport,
  type ModelCallSpend,
  type ModelCallSink,
  type ModelOperation,
  type ModelOperationEvent,
  type ModelOperationKind,
  type ModelOperationOutcome,
  type ModelOperationPhase,
  type ModelOperationSink,
  type SpendSource,
  type SpendTally,
} from './model-call';
export { buildModelCallEvent } from './model-call-event';
