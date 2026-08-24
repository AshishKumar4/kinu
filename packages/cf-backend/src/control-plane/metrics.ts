/**
 * The metrics panel's data, assembled from queries this file does not write.
 *
 * THE SEAM, and why it is here rather than inlined into the route: the analytics
 * WRITER owns the slot layout, so the reader must not restate a column position.
 * `controlPlaneMetricsQueries` builds the SQL from the same frozen schema objects
 * `writeDataPoint` is fed from, which makes a slot rename a type error on the
 * writer's side instead of a column of zeros on this one. Every aggregate it
 * emits is `_sample_interval`-weighted, because Analytics Engine downsamples per
 * index value at volume and an unweighted `COUNT()` under-reports by exactly the
 * sample rate — worst precisely for the busiest workspace.
 *
 * This file therefore does three things and no more: pick the window, resolve a
 * workspace filter to the digest the dataset is indexed by, and hand the batch to
 * the transport.
 */
import { analyticsDigest } from '../analytics/privacy';
import { controlPlaneMetricsQueries } from '../analytics/query';
import {
  analyticsMissingSettings, runAnalyticsBatch, type AnalyticsPanels, type AnalyticsSqlEnv,
} from './analytics-sql';

/**
 * Windows an operator may ask for.
 *
 * A closed set rather than a free number: the window goes into a SQL `INTERVAL`
 * and the results are cached per window, so an open range is both an injection
 * surface and a cache with one entry per distinct hour anybody ever typed.
 */
const WINDOWS = [1, 6, 24, 72, 168, 720] as const;

/** Nearest allowed window at or above the request, falling back to the widest.
 *  Rounding UP rather than rejecting: an operator asking for 12 hours wants a
 *  day, not an error. */
function resolveWindow(hours: number): number {
  return WINDOWS.find((candidate) => candidate >= hours) ?? WINDOWS[WINDOWS.length - 1];
}

/** What the query builder is asked for. `workspaceDigest` is absent, never
 *  empty, when no workspace filter applies. */
interface MetricsQueryRequest {
  sinceHours: number;
  workspaceDigest?: string;
}

export interface MetricsRequest {
  hours: number;
  /** A workspace NAME. Digested here, because the dataset is indexed by digest
   *  and the raw name is deliberately unrecoverable from analytics — a workspace
   *  name is mission-derived, and therefore user text. */
  workspace?: string;
}

export interface ControlMetrics {
  /** The window actually measured, after clamping. Reported so a panel labels
   *  itself with the window it got rather than the one it asked for. */
  windowHours: number;
  /** Which required settings are absent. Empty when analytics is configured. */
  missing: readonly string[];
  panels: AnalyticsPanels;
}

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
  const ask: MetricsQueryRequest = { sinceHours: windowHours };
  if (workspace !== undefined && workspace.length > 0) {
    ask.workspaceDigest = await analyticsDigest(workspace);
  }
  const queries = new Map(Object.entries(controlPlaneMetricsQueries(ask)));
  return { windowHours, missing, panels: await runAnalyticsBatch(env, queries) };
}

/** The windows the view offers, so the picker and the clamp are one list. */
export const METRICS_WINDOWS: readonly number[] = WINDOWS;
