/**
 * The pace of recovery work that must never give up.
 *
 * Every durable lane in this system re-enters work an interruption left behind:
 * a notice whose delivery was refused, a maintenance pass that did not finish,
 * a background job whose isolate died mid-attempt. None of them may stop trying
 * — a cap there discards the user's work over a platform event that says nothing
 * about whether the work is possible — and none of them may retry at the speed
 * of the loop that noticed, or a persistently failing sweep becomes a 1 Hz
 * hammer on the same rows.
 *
 * So: unbounded ATTEMPTS with a bounded PACE, which is the retry doctrine every
 * provider path here already follows.
 *
 * ONE CURVE, and that is why this lives in core rather than beside its first
 * caller. The notice lane, the maintenance tick's re-arm and the job runner's
 * deferral are the same decision about the same kind of event, and a second
 * definition of it is the drift this repository keeps paying to remove.
 */

/**
 * How long to wait before attempt `attempts + 1`: one second, doubling, to a
 * sixty-second ceiling.
 *
 * `attempts` is how many attempts have already been made, so the FIRST wait —
 * the one after a single interruption — is the curve's first term, one second.
 * Clamped at both ends: the exponent saturates before the doubling could
 * overflow, and the result is capped at the ceiling, so a caller that keeps
 * counting can keep calling without special-casing a number it never chose.
 */
export function recoveryBackoffMs(attempts: number): number {
  return Math.min(1000 * 2 ** Math.min(attempts, 6), 60_000);
}
