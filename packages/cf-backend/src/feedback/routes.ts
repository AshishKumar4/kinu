/**
 * `POST /api/feedback` as the Worker sees it: the platform wiring, and nothing
 * else. The policy lives in `./submit`, which imports no binding, no Durable
 * Object and no analytics dataset — so the refusal order, the PNG check and the
 * orphan cleanup are all drivable from a unit test, and a type error in an
 * unrelated Durable Object cannot make the feedback policy untestable.
 *
 * This file is the seam where that policy meets four things only a deployment
 * has: an R2 bucket, the control-plane ingest door, the analytics sink, and the
 * clock.
 */

import type { AuthIdentity } from '../auth/session';
import { writeFeedbackMarker } from '../analytics/feedback-marker';
import { recordFeedback, type ControlPlaneEnv } from '../control-plane/feedback-ingest';
import { FEEDBACK_SCREENSHOT_TYPE } from './contract';
import { routeFeedback } from './submit';

/**
 * The bindings this endpoint reaches, stated structurally: the generated `Env`
 * satisfies it without this module editing that type, and the shape says
 * exactly which three bindings a feedback request can touch.
 */
export interface FeedbackEnv extends ControlPlaneEnv {
  /** Optional on purpose. A deployment with no bucket answers a clean 503 for a
   *  screenshot and still takes note-only reports. */
  FEEDBACK_BUCKET?: R2Bucket;
  FEEDBACK_MARKERS?: AnalyticsEngineDataset;
}

/** What server.ts calls. Returns null for any other path, so the route table
 *  reads the same as every other module's hook. */
export async function handleFeedbackRequest(
  request: Request,
  env: FeedbackEnv,
  identity: AuthIdentity | null,
): Promise<Response | null> {
  const bucket = env.FEEDBACK_BUCKET;
  return routeFeedback(request, identity, {
    store: bucket === undefined ? null : {
      async put(key, bytes) {
        await bucket.put(key, bytes, { httpMetadata: { contentType: FEEDBACK_SCREENSHOT_TYPE } });
      },
      async delete(key) { await bucket.delete(key); },
    },
    record: (row) => recordFeedback(env, row),
    mark: (marker) => { writeFeedbackMarker(env, marker); },
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  });
}
