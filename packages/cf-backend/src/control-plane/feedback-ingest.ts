/**
 * The one door feedback metadata comes through.
 *
 * It exists so the feedback handler never derives a control-plane capability
 * itself. There is exactly one call to `internalCaller` on this path, in this
 * file, which is what makes "the feedback endpoint holds the ingest grade and
 * never the admin grade" a property of the code rather than a convention. A
 * handler that could reach `adminCaller` would be one import away from reading
 * every account's workspaces.
 *
 * It never throws. The caller has already written bytes to R2 by the time it
 * runs and deletes that object when this does not return an id, so a thrown
 * error and a returned `{ error }` would be two ways to say the same thing and
 * only one of them is checkable at the type level.
 */
import { renderThrownChain, diagnostics, toKinuError } from '@kinu.run/core/obs';
import type { FeedbackRecord } from '../feedback/contract';
import { controlPlaneStub, hasControlPlane, type ControlPlaneEnv } from './stub';
import { internalCaller } from './admin-caller';

export type { ControlPlaneEnv } from './stub';

export type FeedbackIngestOutcome = { id: string } | { error: string };

/**
 * Commit one submission's metadata row.
 *
 * The screenshot bytes are already in R2 and are not touched here: this row
 * carries `objectKey` and the store never holds an image.
 */
export async function recordFeedback(
  env: ControlPlaneEnv,
  row: FeedbackRecord,
): Promise<FeedbackIngestOutcome> {
  // Feedback is the one path where an absent binding IS a lost report: the
  // reporter is waiting for an id and the screenshot is already in R2, so this
  // says so rather than answering as if the row landed.
  if (!hasControlPlane(env)) {
    return { error: 'This deployment has no control plane to record feedback in.' };
  }
  try {
    const caller = await internalCaller(env);
    return await controlPlaneStub(env).recordFeedback(caller, row);
  } catch (cause) {
    // A lost report is our failure, not the reporter's, so it is reported as a
    // failure rather than counted with client errors. The note is NOT logged: it
    // is user-authored text and this line goes to Workers Logs.
    diagnostics.failure('control_plane.feedback_write_failed', toKinuError({
      doing: 'storing a feedback submission in the control plane',
      cause,
      otherwise: 'unavailable',
    }), { feedbackId: row.id, hasScreenshot: row.objectKey !== null });
    return { error: renderThrownChain({ cause }) };
  }
}
