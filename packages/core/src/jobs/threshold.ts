// withBackgroundThreshold — the >30s auto-background race.
//
// Runs a tool's work and races it against a threshold. If it finishes first,
// the result is returned inline (the common, fast case — no job, no overhead).
// If the threshold elapses, the still-running promise is handed to `deps.detach`
// (which the orchestrator wraps in a durable runFiber that keeps the DO alive,
// settles the job, and publishes a completion event the reactor drains into a
// synthesis turn) and the model gets a BackgroundHandle immediately — "this is
// continuing in the background; you'll be woken with the result."

/** Returned to the model when a tool call is moved to the background. */
export interface BackgroundHandle {
  readonly background: true;
  readonly jobId: string;
  readonly kind: string;
  readonly message: string;
}

export function isBackgroundHandle(v: unknown): v is BackgroundHandle {
  return typeof v === 'object' && v !== null && (v as { background?: unknown }).background === true;
}

export interface ThresholdDeps {
  /** Override the default 30s threshold. */
  thresholdMs?: number;
  /** Create the background_jobs row and return its id. */
  createJob: (kind: string) => string;
  /** Keep the in-flight promise alive durably, settle the job on resolve/reject,
   *  and wake the agent. The orchestrator implements this with runFiber. */
  detach: (jobId: string, promise: Promise<unknown>) => void;
}

const DEFAULT_THRESHOLD_MS = 30_000;
const TIMED_OUT = Symbol('timed-out');

export async function withBackgroundThreshold<T>(
  kind: string,
  exec: () => Promise<T>,
  deps: ThresholdDeps,
): Promise<T | BackgroundHandle> {
  const thresholdMs = deps.thresholdMs ?? DEFAULT_THRESHOLD_MS;
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

  // Slow path: detach to the background.
  const jobId = deps.createJob(kind);
  deps.detach(jobId, promise);
  return {
    background: true,
    jobId,
    kind,
    message:
      `The "${kind}" task is taking longer than ${Math.round(thresholdMs / 1000)}s, so it is now ` +
      `running in the background. You will be woken with the result when it completes ` +
      `(jobId=${jobId}). End your turn now; do not wait.`,
  };
}
