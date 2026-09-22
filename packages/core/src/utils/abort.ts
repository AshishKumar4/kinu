/** An abort's reason as an Error: own `Error` passes verbatim; non-Error reasons travel on the cause chain. */
export function abortCause(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;

  if (reason instanceof Error) return reason;

  if (reason === undefined) return new DOMException('Aborted', 'AbortError');

  return new Error('the wait was aborted', { cause: reason });
}
