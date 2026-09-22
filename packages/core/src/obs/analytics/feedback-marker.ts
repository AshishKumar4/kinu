/**
 * One data point per feedback submission, carrying nothing the person said: the note, screenshot
 * and route stay in R2 and the control plane's row.
 */
import { analyticsPlane, type AnalyticsEnv } from './writer';
import { FEEDBACK_MARKERS_SCHEMA, type AnalyticsRow } from './schemas';
import { toKinuError } from '../error';
import { diagnostics } from '../log';

/**
 * Closed union: a raw route would carry a mission-derived workspace slug (user text). One bucket
 * per route family in `App.tsx`'s route table; `other` catches unrecognised segments.
 */
export type FeedbackRouteFamily =
  | 'home'
  | 'workspace'
  | 'explore'
  | 'settings'
  | 'control'
  | 'triggers'
  | 'other';

/**
 * Split by who has to fix it. `storage_unavailable` and `row_write_failed` mean the report was
 * lost, not refused. `''` means accepted, so `rejectReason != ''` is exactly the rejection set.
 */
export type FeedbackRejectReason =
  | ''
  | 'unauthenticated'
  | 'bad_content_type'
  | 'too_large'
  | 'malformed'
  | 'no_content'
  | 'storage_unavailable'
  | 'row_write_failed'
  | 'unowned_workspace'
  | 'workspace_unverified';

/** Not derived from the route's request type, so a change there cannot widen what is published. */
export interface FeedbackMarker {
  /** The index. AE samples per index value, so a unique-per-row index keeps counts exact. */
  readonly feedbackId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly rejectReason: FeedbackRejectReason;
  readonly routeFamily: FeedbackRouteFamily;
  /** From the part's presence, not a byte count: a refusal can precede measuring the bytes. */
  readonly hasScreenshot: boolean;
  /** Bytes received for a refusal; bytes stored for an accepted report. */
  readonly screenshotBytes: number;
  /** Characters; never the note. */
  readonly noteLength: number;
  readonly annotated: boolean;
}

/** Fire-and-forget; never throws; no-op when the dataset is unbound. */
export function writeFeedbackMarker(env: AnalyticsEnv, marker: FeedbackMarker): void {
  const row: AnalyticsRow<typeof FEEDBACK_MARKERS_SCHEMA> = {
    feedbackId: marker.feedbackId,
    kind: 'feedback',
    outcome: marker.outcome,
    rejectReason: marker.rejectReason,
    routeFamily: marker.routeFamily,
    count: 1,
    screenshot: marker.hasScreenshot ? 1 : 0,
    screenshotBytes: marker.screenshotBytes,
    noteLength: marker.noteLength,
    annotated: marker.annotated ? 1 : 0,
  };

  try {
    analyticsPlane(env).feedback.write(row);
  } catch (err) {
    diagnostics.failure('analytics.feedback_marker_failed', toKinuError({
      doing: 'writing a feedback marker data point',
      cause: err,
      otherwise: 'unavailable',
    }));
  }
}

const ROUTE_FAMILIES = {
  '': 'home',
  workspace: 'workspace',
  mcts: 'explore',
  // Workspace (`/settings/:agentId`) and account (`/user/settings`) settings share one bucket.
  settings: 'settings',
  user: 'settings',
  control: 'control',
  triggers: 'triggers',
} as const satisfies Readonly<Record<string, FeedbackRouteFamily>>;

export function feedbackRouteFamily(route: string): FeedbackRouteFamily {
  const [, first = ''] = route.split('/', 2);

  for (const [segment, family] of Object.entries(ROUTE_FAMILIES)) {
    if (segment === first) return family;
  }

  return 'other';
}
