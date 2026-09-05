/**
 * One wait shape for every CLI loop that asks another party until it answers.
 *
 * `kinu auth` asks the hub whether the browser approved the sign-in. `kinu
 * connect` asks it whether the daemon showed up. A running turn asks the agent
 * whether a device consent is pending. Each is the same loop: ask, and when the
 * answer is "not yet", show progress, pause, ask again.
 *
 * The wait ends on the answering side's own signal (an answer, or a failure it
 * throws) or on the caller's abort. It carries no clock. A clock ends the wait
 * on a number nobody measured while the daemon it waits for is still starting,
 * and it reports that as the daemon's failure.
 */

export interface WaitOptions {
  /** The pause between one answer of "not yet" and the next question. */
  readonly intervalMs: number;
  /** Runs after every answer of "not yet", so the surface can show progress. */
  onWaiting?: () => void;
}

export interface StoppableWaitOptions extends WaitOptions {
  /** Ends the wait: the promise resolves `undefined` once this aborts. */
  readonly signal: AbortSignal;
}

/**
 * Ask `probe` until it answers. `undefined` from the probe means "not yet".
 * Resolves the probe's answer, or `undefined` when `signal` aborted first; a
 * wait with no signal ends only on an answer. A probe that throws ends the
 * wait with its error.
 */
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

/** Resolve after `ms`, or as soon as `signal` aborts. */
export function pause(ms: number, signal?: AbortSignal): Promise<void> {
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
