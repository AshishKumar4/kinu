/**
 * The one door feedback metadata comes through: the only `internalCaller` on this
 * path, so the feedback handler never holds the admin grade. Never throws; the caller deletes the R2 object when no id returns.
 */
import { renderThrownChain, diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { FeedbackRecord } from '@kinu.run/core';
import { controlPlaneStub, hasControlPlane, type ControlPlaneEnv } from './stub';
import type { ControlPlaneDO } from './control-plane-do';
import { internalCaller } from './admin-caller';

export type FeedbackSink = Pick<ControlPlaneDO, 'recordFeedback'>;

/** Optional: absence is reported to the reporter, not counted as a refused write. */
export type FeedbackIngestEnv<Id> = Partial<ControlPlaneEnv<Id, FeedbackSink>>;

export type FeedbackIngestOutcome = { id: string } | { error: string };

/** Commit one submission's metadata row; the store never holds image bytes. */
export async function recordFeedback<Id>(
  env: FeedbackIngestEnv<Id>,
  row: FeedbackRecord,
): Promise<FeedbackIngestOutcome> {
  // Here an absent binding IS a lost report: the reporter waits for an id and the screenshot is in R2.
  if (!hasControlPlane(env)) {
    return { error: 'This deployment has no control plane to record feedback in.' };
  }

  try {
    const caller = await internalCaller(env);

    return await controlPlaneStub(env).recordFeedback(caller, row);
  } catch (cause) {
    // Our failure, not a client error. Never log the note: user-authored text, and this goes to Workers Logs.
    diagnostics.failure('control_plane.feedback_write_failed', toKinuError({
      doing: 'storing a feedback submission in the control plane',
      cause,
      otherwise: 'unavailable',
    }), { feedbackId: row.id, hasScreenshot: row.objectKey !== null });

    return { error: renderThrownChain({ cause }) };
  }
}
