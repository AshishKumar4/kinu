/** `@kinu.run/core/control-plane`: operator read models and the capability gate. */
export type { ControlPlaneSql, ControlPlaneSqlRow, ControlPlaneSqlValue } from './sql';

export {
  AUDIT_OUTCOMES,
  ControlAuditRowSchema,
  ControlOverviewSchema,
  MonitorIncidentSchema,
  ControlUserRowSchema,
  ControlWorkspaceRowSchema,
  CONTROL_PAGE_DEFAULT,
  CONTROL_PAGE_MAX,
  appendAudit,
  forgetWorkspace,
  getUser,
  initControlPlaneSchema,
  listAudit,
  listPendingAudit,
  listUsers,
  listWorkspaces,
  observeUser,
  observeWorkspace,
  replaceUserWorkspaces,
  settleAudit,
  overview,
  touchWorkspace,
  recordFeedback,
  listFeedback,
  type ControlFeedbackRow,
  type FeedbackWritten,
  type AuditDraft,
  type AuditOutcome,
  type AuditSettlement,
  type ControlAuditRow,
  type ControlOverview,
  type MonitorIncident,
  type ControlUserRow,
  type ControlWorkspaceRow,
  type ReconcileOutcome,
  type RosterWorkspace,
  type UserObservation,
  type WorkspaceFilter,
  type WorkspaceObservation,
} from './store';

export {
  ControlPlaneUnconfiguredError,
  adminControlToken,
  internalCaller,
  requireControl,
  type ControlCaller,
  type ControlCapability,
  type ControlGrade,
  type ControlSecretEnv,
  type PresentedCaller,
} from './capability';

export {
  AnalyticsResultSchema,
  analyticsMissingSettings,
  runAnalyticsBatch,
  type AnalyticsPanels,
  type AnalyticsQuerySet,
  type AnalyticsResult,
  type AnalyticsRow,
  type AnalyticsSqlEnv,
} from './analytics-sql';

export { FeedbackRecordSchema } from '../feedback/contract';

export {
  ControlMetricsSchema,
  METRICS_WINDOWS,
  controlPlaneMetrics,
  type ControlMetrics,
  type MetricsRequest,
} from './metrics';

export {
  FLEET_PROBE_PREFIX,
  sampleFleet,
  settleFleet,
  type FleetEnv,
} from './fleet-alerts';

// The Gallery's index lives in the control plane's database: its object imports it here, not through the slates barrel.
export { GalleryIndex } from '../slates/gallery';

export { GalleryListingSyncSchema, type GalleryListingSync } from '../slates/share-modes';
