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
  StepUsage,
} from './types.js';

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
