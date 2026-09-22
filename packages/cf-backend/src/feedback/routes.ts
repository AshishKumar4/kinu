/**
 * `POST /api/feedback` as the Worker sees it: the platform wiring, and nothing
 * else. The policy lives in `./submit`, which imports no binding, no Durable
 * Object and no analytics dataset — so the refusal order, the PNG check and the
 * orphan cleanup are all drivable from a unit test, and a type error in an
 * unrelated Durable Object cannot make the feedback policy untestable.
 *
 * This file is the seam where that policy meets five things only a deployment
 * has: an R2 bucket, the control-plane ingest door, the analytics sink, the
 * clock, and the owner's workspace registry.
 */

import type { AuthIdentity } from '../auth/session';
import { renderThrownChain } from '@kinu.run/core/obs';
import { writeFeedbackMarker, type AnalyticsEnv } from '@kinu.run/core/analytics';
import { recordFeedback, type FeedbackIngestEnv } from '../control-plane/feedback-ingest';
import { retryTransientDO } from '@kinu.run/core';
import type { UserDO } from '../user/user-do';
import { isWorkspaceName } from '@kinu.run/core';
import { ownerCaller, type OwnerCapabilityEnv } from '@kinu.run/core';
import { FEEDBACK_SCREENSHOT_TYPE } from '@kinu.run/core';
import type { ObjectNamespace } from '../bindings';
import { routeFeedback, type WorkspaceAttribution } from './submit';

/** The one registry call an attribution makes on the reporter's own account
 *  object. */
export type FeedbackRegistry = Pick<UserDO, 'hasWorkspace'>;

/** What the screenshot path does to the bucket: the write, and the delete that
 *  removes an object no row ever pointed at. */
export type FeedbackBucket = Pick<R2Bucket, 'put' | 'delete'>;

/**
 * The bindings this endpoint reaches, stated structurally: the generated `Env`
 * satisfies it without this module editing that type, and the shape says
 * exactly which bindings a feedback request can touch.
 *
 * Three of them are OPTIONAL, and each absence is a state this endpoint
 * answers rather than a binding it assumes: the ingest door reports a missing
 * control plane to the reporter (`FeedbackIngestEnv`), a deployment with no
 * bucket refuses a screenshot and still takes note-only reports, and an
 * unbound analytics dataset makes the marker a no-op (`AnalyticsEnv`).
 */
export interface FeedbackEnv<Id> extends FeedbackIngestEnv<Id>, OwnerCapabilityEnv, AnalyticsEnv {
  /** The reporter's own registry — the authority on which workspaces are
   *  theirs. Required, unlike the three above: a deployment that cannot answer
   *  that question refuses a workspace attribution rather than guessing it. */
  UserDO: ObjectNamespace<Id, FeedbackRegistry>;
  FEEDBACK_BUCKET?: FeedbackBucket;
}

/**
 * Whether the reporter's registry holds the workspace their report names.
 *
 * THE REGISTRY READ AND NOTHING ELSE. `claimOwnedWorkspace` is the gate for
 * REACHING a workspace, and it wakes that workspace's OrchestratorAgent and
 * provisions its capability token to do it. Attributing a report is not
 * reaching one: waking a Durable Object per feedback submission is a side
 * effect nobody asked for, on a path that only needs to know whose name this
 * is. `hasWorkspace` is the membership half both callers share, and it is asked
 * of the caller's OWN UserDO, so no name a stranger sends reaches anything but
 * their own registry.
 *
 * The name is checked against the registry's own grammar FIRST, because
 * `hasWorkspace` throws on a name it could never hold, and a thrown answer is
 * indistinguishable from the platform dropping the call — the one thing this
 * function must never confuse.
 */
async function attributeWorkspace<Id>(
  env: FeedbackEnv<Id>,
  userId: string,
  workspace: string,
): Promise<WorkspaceAttribution> {
  if (!isWorkspaceName(workspace)) return { kind: 'refused' };

  try {
    const caller = await ownerCaller(env);
    const userDO = env.UserDO.get(env.UserDO.idFromName(userId));
    const owned = await retryTransientDO('hasWorkspace', () => userDO.hasWorkspace(caller, workspace));

    return owned ? { kind: 'owned', workspace } : { kind: 'refused' };
  } catch (cause) {
    // Every failure here is ours to explain, never a refusal: a deployment with
    // no owner capability, a UserDO the platform dropped, and a schema fault all
    // mean the question went unanswered. Reporting any of them as "not yours"
    // would blame a reporter for our outage and hide it from the rejection rate.
    return { kind: 'unavailable', error: renderThrownChain({ cause }) };
  }
}

/** What server.ts calls. Returns null for any other path, so the route table
 *  reads the same as every other module's hook. */
export async function handleFeedbackRequest<Id>(
  request: Request,
  env: FeedbackEnv<Id>,
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
    attributeWorkspace: (userId, workspace) => attributeWorkspace(env, userId, workspace),
    mark: (marker) => { writeFeedbackMarker(env, marker); },
    newId: () => crypto.randomUUID(),
    now: () => Date.now(),
  });
}
