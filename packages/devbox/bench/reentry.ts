/** The reentry probe's record (D26), shared by the probe and its driver; no runtime imports. */

/** A timer set before the start block that falls due inside it. */
export const REENTRY_PENDING = ['connection', 'alarm', 'stray'] as const;

export type ReentryPending = (typeof REENTRY_PENDING)[number];

/** `hookExecMs` null with `hookExited` set: the window closed before the reply. */
export interface ReentryStamp {
  readonly windowMs: number;
  readonly holdMs: number;
  readonly pending: ReentryPending;
  readonly started: number;
  readonly armed: boolean;
  readonly firstStartMs: number | null;
  readonly openerExecMs: number | null;
  readonly hookEntered: number | null;
  readonly hookExecMs: number | null;
  readonly hookExecError: string | null;
  readonly lateReplyAt: number | null;
  readonly hookExited: number | null;
  readonly reentryReturned: number | null;
  readonly error: string | null;
}
