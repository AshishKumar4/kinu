// withBackgroundThreshold — the auto-background race.
//
// Runs a tool's work and races it against the surface's detach threshold. If it
// finishes first, the result is returned inline (the common, fast case — no job,
// no overhead). If the threshold elapses, the still-running promise is handed to
// `deps.onThreshold` (which the orchestrator wraps in a durable runFiber that
// keeps the DO alive, settles the job, and publishes a completion event the
// reactor drains into a synthesis turn) and the model gets a BackgroundHandle
// immediately — "this is continuing in the background; you'll be woken with the
// result." When too many jobs are already in flight the detach is refused
// instead: the work is cancelled and the model is told why.

/** Who owns the session, which is what makes a detach cheap or expensive.
 *  Not a toggle — every session has exactly one of these, fixed at construction. */
export type SessionSurface = 'interactive' | 'one-shot';

export interface BackgroundPolicy {
  /** How long a tool call may run before it is moved to the background. */
  readonly detachAfterMs: number;
  /** How long teardown waits on work that has not settled before leaving it. */
  readonly settleGraceMs: number;
}

/**
 * The two policies, and why they differ.
 *
 * `interactive` — a human is watching the stream, so a tool call that outlives
 * their patience must hand back a handle fast; the wake turn arrives in the
 * same live session, and teardown can afford to wait a while for in-flight work
 * because the session was going to stay open anyway.
 *
 * `one-shot` — nobody is waiting on a fast turn, and the process exits after the
 * answer. Here a detach is expensive, not cheap: it truncates the turn, forces a
 * second (synthesis) turn, and — measured over an 89-task benchmark run — pushes
 * the model into polling its own jobs instead of doing the work (151 of 202
 * sandbox scripts were `agent.jobResult` polls, and forks were spawned as
 * pollers rather than workers). So ordinary long work — a build, a test suite,
 * an install — runs to completion inline, and only genuinely non-terminating
 * work (a server, a VM) ever crosses. Because anything that DID cross is very
 * unlikely to finish at all, teardown gives it a short grace and then leaves it
 * running rather than joining it: that unbounded join was 6.4 of 16.2 agent-hours
 * of pure idle tail in the same run.
 */
export const BACKGROUND_POLICY: Readonly<Record<SessionSurface, BackgroundPolicy>> = {
  interactive: { detachAfterMs: 30_000, settleGraceMs: 300_000 },
  'one-shot': { detachAfterMs: 300_000, settleGraceMs: 120_000 },
};

/** Returned to the model when a tool call is moved to the background. */
export interface BackgroundHandle {
  readonly background: true;
  readonly jobId: string;
  readonly kind: string;
  readonly message: string;
}

/** Returned to the model when a tool call crossed the threshold but could NOT
 *  be detached — too many jobs are already in flight. The work was cancelled. */
export interface BackgroundRefusal {
  readonly background: false;
  readonly kind: string;
  readonly message: string;
}

export function isBackgroundHandle(v: unknown): v is BackgroundHandle {
  return typeof v === 'object' && v !== null && (v as { background?: unknown }).background === true;
}

/** What `onThreshold` decided: the job it minted, or why it refused. */
export type DetachOutcome =
  | { readonly detached: true; readonly jobId: string }
  | { readonly detached: false; readonly reason: string };

export interface ThresholdDeps {
  /** Override the surface's detach threshold. */
  thresholdMs?: number;
  /** The threshold elapsed. Either mint a background job and keep `promise`
   *  alive durably (settling the job and waking the agent when it resolves), or
   *  refuse — in which case the implementation has already cancelled the work
   *  and `reason` is what the model is told. */
  onThreshold: (kind: string, promise: Promise<unknown>) => DetachOutcome;
}

const TIMED_OUT = Symbol('timed-out');

export async function withBackgroundThreshold<T>(
  kind: string,
  exec: () => Promise<T>,
  deps: ThresholdDeps,
): Promise<T | BackgroundHandle | BackgroundRefusal> {
  const thresholdMs = deps.thresholdMs ?? BACKGROUND_POLICY.interactive.detachAfterMs;
  const promise = exec();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), thresholdMs);
  });
  // Wrap with both handlers so the abandoned branch never throws unhandled.
  const settled = promise.then((value) => ({ value }), (error: unknown) => ({ error }));
  const winner = await Promise.race([settled, timeout]);
  if (timer) clearTimeout(timer);

  if (winner !== TIMED_OUT) {
    if ('error' in winner) throw winner.error;
    return winner.value;
  }

  // Slow path: hand the live work to the background runner.
  const outcome = deps.onThreshold(kind, promise);
  if (!outcome.detached) {
    return { background: false, kind, message: outcome.reason };
  }
  return {
    background: true,
    jobId: outcome.jobId,
    kind,
    message:
      `The "${kind}" task is taking longer than ${Math.round(thresholdMs / 1000)}s, so it is now ` +
      `running in the background. You will be woken with the result when it completes ` +
      `(jobId=${outcome.jobId}). End your turn now; do not wait.`,
  };
}
