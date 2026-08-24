/**
 * The feedback marker: one data point per submission, and nothing about what the
 * person said.
 *
 * ## The line this module exists to hold
 *
 * A bug report is the single richest piece of free text a product ever receives,
 * and every field of it is exactly what must not reach a fleet-wide dataset with
 * three-month retention and an admin-facing reader. So the note, the screenshot
 * and the route live where they belong — R2 and the control plane's own row —
 * and what crosses into analytics is: a report happened, how big it was, whether
 * we kept it, and if not, why.
 *
 * `noteLength` is the shape of that compromise. "Are people writing real reports
 * or mashing the button" is a question worth answering and it does not require
 * one word of the report to answer it.
 *
 * `routeFamily` is a CLOSED UNION and the reason is not fussiness: a route string
 * here would read `/workspace/my-personal-assistant-f0e4afa6`, and a workspace
 * slug is mission-derived — the person's own sentence, shortened. No redactor can
 * recognise user text inside a path, so the only safe shape is one this module
 * declares in advance.
 *
 * ## Why rejections are rows too
 *
 * `storage_unavailable` and `row_write_failed` mean a report was LOST, not
 * refused. Pooling those with `bad_content_type` would make both rates unreadable
 * and would hide the only two arms that mean we are dropping user reports on the
 * floor. The reason set is therefore closed and split by owner: who has to fix
 * the arm decides whether it gets its own value.
 */
import { analyticsPlane, type AnalyticsEnv } from './writer';
import { FEEDBACK_MARKERS_SCHEMA, type AnalyticsRow } from './schemas';
import { diagnostics, toKinuError } from '@kinu.run/core/obs';

/**
 * The first path segment of the route a report was filed from, mapped onto our
 * own vocabulary.
 *
 * ONE BUCKET PER REGISTERED ROUTE FAMILY, verified against `App.tsx`'s route
 * table rather than guessed: `/`, `/user/settings`, `/user/settings/mcp`,
 * `/workspace/:id`, `/workspace/:id/agents/:sub`, `/mcts/:id`, `/control`,
 * `/settings/:id`, `/triggers/:id`. A registered route that falls to `other`
 * reads as "we do not know where this came from", which is the answer for a URL
 * nobody recognises and a lie for a page we shipped.
 *
 * `other` stays as the catch-all so an unrecognised segment becomes a known
 * unknown instead of being passed through as user text.
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
 * Why a submission was refused. Split by who has to fix it:
 *
 *   `unauthenticated`     the caller had no identity — 401.
 *   `bad_content_type`    not multipart, or a screenshot part that is not PNG.
 *   `too_large`           over the 8 MiB screenshot ceiling.
 *   `malformed`           PNG bytes failed structural validation.
 *   `no_content`          empty note AND no screenshot — a UI defect, since the
 *                         send control should not have been usable.
 *   `storage_unavailable` the object store is not reachable. OUR outage; the
 *                         report was fine and is gone.
 *   `storage_unavailable` and `row_write_failed` are the two that mean a report
 *                         was LOST rather than refused, which is why neither is
 *                         folded into `malformed`.
 *   `row_write_failed`    the durable row could not be written and the orphaned
 *                         object was deleted. OUR defect, same consequence.
 *
 * The empty string is reserved for an accepted submission, so `rejectReason != ''`
 * is exactly the rejection set and no query needs to know the arms to count them.
 */
export type FeedbackRejectReason =
  | ''
  | 'unauthenticated'
  | 'bad_content_type'
  | 'too_large'
  | 'malformed'
  | 'no_content'
  | 'storage_unavailable'
  | 'row_write_failed';

/**
 * One submission's marker. Deliberately not derived from the feedback route's own
 * request type: the fields absent here are the point of the module, and a type
 * that could be widened by a change on the route's side would lose that.
 */
export interface FeedbackMarker {
  /** The opaque id the route answers with. High-cardinality and therefore the
   *  index, which is also what keeps this dataset out of AE's sampler: sampling
   *  is per index VALUE, so a unique-per-row index never accumulates enough
   *  events to be sampled and feedback counts stay exact. */
  readonly feedbackId: string;
  readonly outcome: 'accepted' | 'rejected';
  readonly rejectReason: FeedbackRejectReason;
  readonly routeFamily: FeedbackRouteFamily;
  /** Kept alongside `screenshotBytes` because a 0-byte accepted PNG and no
   *  screenshot at all are different failures, and one number cannot say which. */
  readonly hasScreenshot: boolean;
  readonly screenshotBytes: number;
  /** Characters. Never the note. */
  readonly noteLength: number;
  /** Whether the screenshot carries the reporter's annotations. */
  readonly annotated: boolean;
}

/**
 * Write the marker. Fire-and-forget, never throws, and a no-op when the dataset
 * is not bound — so a deployment without analytics answers the request normally
 * and a failure here can never become the reporter's problem.
 */
export function writeFeedbackMarker(env: AnalyticsEnv, marker: FeedbackMarker): void {
  const row: AnalyticsRow<typeof FEEDBACK_MARKERS_SCHEMA> = {
    feedbackId: marker.feedbackId,
    kind: 'feedback',
    outcome: marker.outcome,
    rejectReason: marker.rejectReason,
    routeFamily: marker.routeFamily,
    count: 1,
    screenshotBytes: marker.hasScreenshot ? marker.screenshotBytes : 0,
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

/**
 * The registered route families, by first path segment.
 *
 * Left INFERRED rather than annotated as an open dictionary: the keys are the
 * whole content of this table, and typing it `Record<string, …>` would say any
 * segment is a key when the point is that only these are. `satisfies` keeps the
 * value check without discarding that.
 */
const ROUTE_FAMILIES = {
  // `/` — the index route.
  '': 'home',
  workspace: 'workspace',
  // `/mcts/:agentId` is the exploration surface; `explore` is what it is called
  // everywhere a person reads it, and the slot holds the concept, not the path.
  mcts: 'explore',
  // BOTH settings surfaces: `/settings/:agentId` is the workspace's, and
  // `/user/settings` is the account's. One bucket, because a report about
  // "settings" is the same report whichever page it was filed from.
  settings: 'settings',
  user: 'settings',
  control: 'control',
  triggers: 'triggers',
} as const satisfies Readonly<Record<string, FeedbackRouteFamily>>;

/**
 * The route family a path belongs to. Exported because the route handler is the
 * only thing that sees the path, and this is the mapping that keeps a slug out of
 * the dataset — leaving it to the caller is leaving it to be got wrong once.
 *
 * A scan over the table's own entries rather than an index, because indexing a
 * closed table with an arbitrary segment is the question the table cannot answer:
 * eight comparisons, and no cast to pretend otherwise.
 */
export function feedbackRouteFamily(route: string): FeedbackRouteFamily {
  const [, first = ''] = route.split('/', 2);
  for (const [segment, family] of Object.entries(ROUTE_FAMILIES)) {
    if (segment === first) return family;
  }
  return 'other';
}
