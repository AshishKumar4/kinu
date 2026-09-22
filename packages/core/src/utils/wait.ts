/** One ask-until-answered loop for CLI waits. Ends on the answer, a thrown failure, or abort; it carries no clock. */

export interface WaitOptions {
  readonly intervalMs: number;
  onWaiting?: () => void;
}

export interface StoppableWaitOptions extends WaitOptions {
  /** The promise resolves `undefined` once this aborts. */
  readonly signal: AbortSignal;
}

/** `undefined` from the probe means "not yet". A wait with no signal ends only on an answer. */
export function waitForAnswer<T>(probe: () => Promise<T | undefined>, opts: StoppableWaitOptions): Promise<T | undefined>;
export function waitForAnswer<T>(probe: () => Promise<T | undefined>, opts: WaitOptions): Promise<T>;
export async function waitForAnswer<T>(
  probe: () => Promise<T | undefined>,
  opts: WaitOptions & { readonly signal?: AbortSignal },
): Promise<T | undefined> {
  for (;;) {
    if (opts.signal?.aborted) return undefined;
    const answer = await probe();

    if (answer !== undefined) return answer;
    opts.onWaiting?.();
    await pause(opts.intervalMs, opts.signal);
  }
}

/** Module-private: an exported sleep lets suites stop waiting for the product's own signal. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();

  if (signal?.aborted) {
    resolve();

    return promise;
  }

  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, ms);

  signal?.addEventListener('abort', onAbort, { once: true });

  return promise;
}
