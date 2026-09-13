/**
 * The metrics panel's orchestration: pick the window, resolve a workspace
 * filter to the digest the dataset is indexed by, hand the batch to the
 * transport.
 *
 * The window policy and the request/response shapes live in
 * `@kinu.run/core/control-plane`; the query builder and the digest live in
 * `../analytics/` until that lane joins core.
 */
import { analyticsDigest } from '../analytics/privacy';
import { controlPlaneMetricsQueries } from '../analytics/query';
import {
  analyticsMissingSettings, clearAnalyticsCache, resolveWindow, runAnalyticsBatch,
  type AnalyticsSqlEnv, type ControlMetrics, type MetricsQueryRequest, type MetricsRequest,
} from '@kinu.run/core/control-plane';

/**
 * Read the metrics panels.
 *
 * With analytics unconfigured this answers with the missing setting names and no
 * panels, which is a state the view renders as a sentence. It is deliberately
 * NOT an error: a deployment that has not minted an analytics token is working,
 * and a 500 there would send an operator looking for an outage.
 */
export async function controlPlaneMetrics(
  env: AnalyticsSqlEnv,
  request: MetricsRequest,
): Promise<ControlMetrics> {
  const windowHours = resolveWindow(request.hours);
  const missing = analyticsMissingSettings(env);

  if (missing.length > 0) return { windowHours, missing, panels: {} };

  const workspace = request.workspace?.trim();

  // Built in two statements rather than with a conditional spread: an unset
  // filter must leave the property ABSENT, and `analyticsDigest('')` returns ''
  // rather than a hash, so a spread that guessed would send an empty digest and
  // silently match nothing.
  const ask: MetricsQueryRequest = {
    sinceHours: windowHours,
    // Staging binds its own datasets and shares production's account, so a
    // reader that did not say which deployment it is would answer a staging
    // panel with production's numbers.
    datasetSuffix: env.ANALYTICS_DATASET_SUFFIX ?? '',
  };

  if (workspace) ask.workspaceDigest = analyticsDigest(workspace);
  const queries = new Map(Object.entries(controlPlaneMetricsQueries(ask)));

  if (request.forceRefresh === true) clearAnalyticsCache();

  return { windowHours, missing, panels: await runAnalyticsBatch(env, queries) };
}
