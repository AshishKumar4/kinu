/** Binding-free: datasets arrive as the structural {@link AnalyticsDatasetSink}. */
export {
  boundaryOf,
  eventFamily,
} from './boundaries';

export {
  writeFeedbackMarker,
  feedbackRouteFamily,
  type FeedbackMarker,
  type FeedbackRouteFamily,
  type FeedbackRejectReason,
} from './feedback-marker';

export {
  installAnalyticsDiagnostics,
} from './install';

export {
  MAX_BLOB_BYTES,
  MAX_WRITES_PER_INVOCATION,
  assertQuantileLevel,
  assertWithinPlatformLimits,
  type SlotCensus,
} from './limits';

export {
  analyticsDigest,
  assertPublishableNames,
} from './privacy';

export {
  controlPlaneMetricsQueries,
  type ControlPlaneMetricQueries,
} from './query';

export {
  recordJobSettled,
  recordModelRow,
  recordSandboxRecovery,
  recordToolRow,
  recordTtftRow,
  recordTurnRow,
  type AgentKind,
  type AgentRowKind,
  type JobRowInput,
  type ModelRowInput,
  type RecoveryRowInput,
  type RowOutcome,
  type ToolRowInput,
  type TtftRowInput,
  type TurnRowInput,
} from './record';

export {
  AGENT_METRICS_SCHEMA,
  ANALYTICS_SCHEMAS,
  CONTROL_PLANE_OPS_SCHEMA,
  FEEDBACK_MARKERS_SCHEMA,
  blobColumn,
  doubleColumn,
  indexColumn,
  type AnalyticsBindingName,
  type AnalyticsRow,
  type AnalyticsSchema,
  type BlobName,
  type BlobSlot,
  type DoubleName,
  type DoubleSlot,
  type IndexName,
  type IndexSlot,
  type ReservedSlotIsNotWritable,
} from './schemas';

export {
  FiniteNumber,
  analyticsPlane,
  openAnalyticsWindow,
  type AnalyticsDataPoint,
  type AnalyticsDatasetSink,
  type AnalyticsEnv,
  type AnalyticsPlane,
  type AnalyticsStats,
  type AnalyticsWindow,
  type AnalyticsWriter,
} from './writer';
