export {
  BackgroundJobStore,
  initBackgroundJobsTable,
  serializeJobResult,
  type BackgroundJob,
  type BackgroundJobStatus,
  type JobClaim,
} from './store';
export {
  withBackgroundThreshold,
  withSpawnDetach,
  isBackgroundHandle,
  BACKGROUND_POLICY,
  SPAWN_STARTED_OPTION,
  readSpawnStarted,
  type BackgroundHandle,
  type BackgroundRefusal,
  type BackgroundPolicy,
  type DetachOutcome,
  type SessionSurface,
  type ThresholdDeps,
} from './threshold';
export {
  BackgroundJobRunner,
  JobNotResumable,
  EVICTION_INTERRUPT_ERROR,
  backgroundJobWakeTrigger,
  MAX_CONCURRENT_DETACHED_JOBS,
  type BackgroundJobRunnerDeps,
  type JobResumer,
} from './runner';
export { AgentWakeQueue } from './wake-queue';
export {
  wrapToolsForBackground,
  CONFINED_BACKGROUNDABLE_TOOLS,
  type BackgroundableTool,
} from './background-wrap';
