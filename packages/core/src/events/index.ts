/**
 * Run events — public surface.
 */

export type {
  RunEvent,
  RunEventBase,
  RunEventInput,
  RunEventType,
  CompletionGateRecord,
  TurnSteeringRecord,
  TurnSteeringTrigger,
  CraftCycleRecord,
  ExecutionRecoveryRecord,
  StepCost,
} from './types.js';

export { FAILURE_WITHOUT_ERROR } from './types.js';

export {
  initRunEventTables,
  parseStoredRunEvent,
  RunEventRecorder,
  type RunEventListener,
  type RunEventQuery,
} from './recorder.js';

export {
  cacheHitRate,
  summarizeSteps,
  CACHE_HIT_EMA_ALPHA,
  type CacheHitStats,
  type StepTelemetry,
} from './step-stats.js';

export {
  SPEND_SOURCES,
  SPEND_SOURCE_LABEL,
  SPEND_SOURCE_DETAIL,
  WORKSPACE_RUN_ID,
  type ModelCallReport,
  type ModelCallSpend,
  type ModelCallSink,
  type SpendSource,
} from './model-call.js';
