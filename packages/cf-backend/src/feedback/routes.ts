/**
 * `POST /api/feedback` platform wiring only; the policy lives in `./submit`, which imports no binding
 * so it stays unit-testable.
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
import type { ObjectNamespace } from '@kinu.run/core';
import { routeFeedback, type WorkspaceAttribution } from './submit';

export type FeedbackRegistry = Pick<UserDO, 'hasWorkspace'>;

/** The write, and the delete that removes an object no row ever pointed at. */
export type FeedbackBucket = Pick<R2Bucket, 'put' | 'delete'>;

/** Structural so the generated `Env` satisfies it. The optional bindings are answered states: missing
 *  control plane is reported, no bucket refuses screenshots, no analytics makes the marker a no-op. */
export interface FeedbackEnv<Id> extends FeedbackIngestEnv<Id>, OwnerCapabilityEnv, AnalyticsEnv {
  /** Required: without it a workspace attribution is refused rather than guessed. */
  UserDO: ObjectNamespace<Id, FeedbackRegistry>;
  FEEDBACK_BUCKET?: FeedbackBucket;
}

/**
 * Registry read only: `claimOwnedWorkspace` would wake the workspace's OrchestratorAgent, a side effect a
 * report must not cause. The name is grammar-checked first because `hasWorkspace` throws on an invalid
 * name, which would be indistinguishable from the platform dropping the call.
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
    // Every failure is our outage, never "not yours", or it would blame the reporter and hide from the rejection rate.
    return { kind: 'unavailable', error: renderThrownChain({ cause }) };
  }
}

/** Returns null for any other path. */
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
