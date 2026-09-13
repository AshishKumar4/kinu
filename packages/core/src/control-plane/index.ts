/**
 * The operator plane's read models and policies, behind
 * `@kinu.run/core/control-plane`.
 *
 * Pure folds over a caller-supplied SQL handle plus the capability gate every
 * ControlPlaneDO method calls first. The Durable Object keeps what only it can
 * hold: the gate's enforcement point and the storage handle.
 */
export type { ControlPlaneSql, ControlPlaneSqlRow, ControlPlaneSqlValue } from './sql';

export {
  AUDIT_OUTCOMES,
  CONTROL_PAGE_DEFAULT,
  CONTROL_PAGE_MAX,
  MalformedCursorError,
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
  analyticsMissingSettings,
  clearAnalyticsCache,
  runAnalyticsBatch,
  type AnalyticsPanels,
  type AnalyticsQuerySet,
  type AnalyticsResult,
  type AnalyticsRow,
  type AnalyticsSqlEnv,
} from './analytics-sql';

export {
  METRICS_WINDOWS,
  controlPlaneMetrics,
  type ControlMetrics,
  type MetricsRequest,
} from './metrics';
