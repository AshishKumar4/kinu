/** An abort's reason as an Error: own `Error` passes verbatim; non-Error reasons travel on the cause chain. */
export function abortCause(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;

  if (reason instanceof Error) return reason;

  if (reason === undefined) return new DOMException('Aborted', 'AbortError');

  return new Error('the wait was aborted', { cause: reason });
}

/**
 * Waits `ms`. An abort ends the wait at once: `'reject'` rejects with its reason (a retry's backoff, a pacer's cooldown),
 * `'resolve'` returns as if the wait ran out (a poll whose caller reads the signal next).
 */
export function abortableSleep(ms: number, signal: AbortSignal | undefined, onAbort: 'reject' | 'resolve'): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const end = (): void => (onAbort === 'resolve' ? resolve() : reject(abortCause(signal)));

  if (signal?.aborted) {
    end();

    return promise;
  }

  const abort = (): void => {
    clearTimeout(timer);
    end();
  };

  const timer = setTimeout(() => {
    signal?.removeEventListener('abort', abort);
    resolve();
  }, ms);

  signal?.addEventListener('abort', abort, { once: true });

  return promise;
}
