import {
  analyticsMissingSettings, clearAnalyticsCache, runAnalyticsBatch,
  type AnalyticsPanels, type AnalyticsSqlEnv,
} from './analytics-sql';
import { analyticsDigest } from '../obs/analytics/privacy';
import { controlPlaneMetricsQueries } from '../obs/analytics/query';

// Closed set: the window lands in a SQL `INTERVAL` and in the cache key.
const WINDOWS = [1, 6, 24, 72, 168, 720] as const;

function resolveWindow(hours: number): number {
  return WINDOWS.find((candidate) => candidate >= hours) ?? WINDOWS[WINDOWS.length - 1];
}

type MetricsQueryRequest = Parameters<typeof controlPlaneMetricsQueries>[0];

export interface MetricsRequest {
  hours: number;
  /** A name; digested here because analytics never holds user text. */
  workspace?: string;
  forceRefresh?: boolean;
}

export interface ControlMetrics {
  /** After clamping. */
  windowHours: number;
  missing: readonly string[];
  panels: AnalyticsPanels;
}

export const METRICS_WINDOWS: readonly number[] = WINDOWS;

export async function controlPlaneMetrics(
  env: AnalyticsSqlEnv,
  request: MetricsRequest,
): Promise<ControlMetrics> {
  const windowHours = resolveWindow(request.hours);
  const missing = analyticsMissingSettings(env);

  if (missing.length > 0) return { windowHours, missing, panels: {} };

  const workspace = request.workspace?.trim();

  // The digest must be absent, not '', when unfiltered: an empty digest matches nothing.
  const ask: MetricsQueryRequest = { sinceHours: windowHours };

  if (workspace) ask.workspaceDigest = analyticsDigest(workspace);
  const queries = new Map(Object.entries(controlPlaneMetricsQueries(ask)));

  if (request.forceRefresh === true) clearAnalyticsCache();

  return { windowHours, missing, panels: await runAnalyticsBatch(env, queries) };
}
