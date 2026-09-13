/**
 * The metrics panel's window policy and request/response shapes.
 *
 * The orchestration (`controlPlaneMetrics`: pick the window, resolve a
 * workspace filter to the digest the dataset is indexed by, hand the batch to
 * the transport) stays in `cf-backend/src/control-plane/metrics.ts` until the
 * analytics query builder joins core; it imports this module rather than
 * restating the policy.
 */
import type { AnalyticsPanels } from './analytics-sql';

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
 *  day, not an error. Shared with the cf-backend orchestration. */
export function resolveWindow(hours: number): number {
  return WINDOWS.find((candidate) => candidate >= hours) ?? WINDOWS[WINDOWS.length - 1];
}

/** What the query builder is asked for. `workspaceDigest` is absent, never
 *  empty, when no workspace filter applies. Shared with the analytics lane's
 *  `controlPlaneMetricsQueries` signature once it joins core. */
export interface MetricsQueryRequest {
  sinceHours: number;
  datasetSuffix: string;
  workspaceDigest?: string;
}

export interface MetricsRequest {
  hours: number;
  /** A workspace NAME. Digested here, because the dataset is indexed by digest
   *  and the raw name is deliberately unrecoverable from analytics — a workspace
   *  name is mission-derived, and therefore user text. */
  workspace?: string;
  /**
   * Ignore the batch cache and re-run the queries.
   *
   * The view's refresh button is the one caller: a dashboard whose refresh
   * answered from the same thirty-second-old batch would look broken while being
   * correct, and "correct" is not what an operator pressing refresh is asking
   * for.
   */
  forceRefresh?: boolean;
}

export interface ControlMetrics {
  /** The window actually measured, after clamping. Reported so a panel labels
   *  itself with the window it got rather than the one it asked for. */
  windowHours: number;
  /** Which required settings are absent. Empty when analytics is configured. */
  missing: readonly string[];
  panels: AnalyticsPanels;
}

/** The windows the view offers, so the picker and the clamp are one list. */
export const METRICS_WINDOWS: readonly number[] = WINDOWS;
