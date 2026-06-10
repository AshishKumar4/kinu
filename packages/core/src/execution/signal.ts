/**
 * Cancellation convention for executor tools.
 *
 * The `run` tool (and other in-process callers) pass a trailing `{ signal }`
 * options argument to an executor's `exec` tool; codemode sandbox calls pass
 * nothing. Executors honor the signal at the strongest level their transport
 * supports — the workspace shell stops between commands, remote executors
 * (sandbox / nimbus / laptop) stop WAITING and reject with an AbortError that
 * states the remote command may still finish, because their protocols expose
 * no kill for an in-flight exec.
 */
export function readExecSignal(context: unknown): AbortSignal | undefined {
  if (!context || typeof context !== 'object' || !('signal' in context)) return undefined;
  const signal = (context as { signal?: unknown }).signal;
  return typeof signal === 'object' && signal !== null && 'aborted' in signal && 'addEventListener' in signal
    ? signal as AbortSignal
    : undefined;
}
