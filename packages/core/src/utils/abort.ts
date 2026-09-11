/**
 * An abort's own reason, as an Error — so a cancelled wait, sleep or run is
 * attributable to whoever cancelled it.
 *
 * Each of the three arms is a real case rather than defensive padding: a
 * caller's own `Error` passes through verbatim, because relabelling it would
 * lose the reason; a bare `controller.abort()` produces the shape every caller
 * of this already handled; and a non-Error reason is named here rather than
 * thrown raw, because a thrown string arrives at a `catch` with no cause chain
 * at all.
 */
export function abortCause(signal?: AbortSignal): Error {
  const reason: unknown = signal?.reason;

  if (reason instanceof Error) return reason;

  if (reason === undefined) return new DOMException('Aborted', 'AbortError');

  return new Error(`the wait was aborted: ${String(reason)}`);
}
