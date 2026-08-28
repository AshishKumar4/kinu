/**
 * Who may start a chat turn right now.
 *
 * One synchronous latch, acquired before any asynchronous send step and
 * released only by the matching send's terminal settle. Reactive state cannot
 * own this: `isStreaming` is React state, so two presses inside one tick — a
 * double click, a keydown racing a click, a held Enter — both read the same
 * not-yet-committed value and both pass the guard, which started two
 * overlapping turns on one conversation.
 *
 * The transitions are pure and separately tested; `useKinu` is the thin React
 * binding over them, the same split `use-async-resource.ts` uses.
 */

/**
 * `owner` is the token of the send holding admission, or null when nobody does.
 * `minted` is the last token issued. Tokens strictly increase, so a settle can
 * prove it is still the owner before releasing — and a stale one cannot open the
 * door for whoever holds the latch next.
 */
export interface SendLatch {
  minted: number;
  owner: number | null;
}

export function newSendLatch(): SendLatch {
  return { minted: 0, owner: null };
}

/**
 * Start one turn under the latch.
 *
 * `true` when this call was admitted and IS that turn; `false` when a turn
 * already holds admission — and then `begin` was never called, so the caller
 * keeps the user's draft rather than destroying it.
 *
 * `begin` must resolve at the turn's TERMINAL settle: finished, failed, or
 * aborted. The AI SDK's `sendMessage` and `regenerate` both do, which is why
 * their promise is the release rather than a separate completion signal.
 */
export function admitTurn(latch: SendLatch, begin: () => Promise<void>): boolean {
  if (latch.owner !== null) return false;
  const token = ++latch.minted;
  latch.owner = token;
  const release = (): void => { if (latch.owner === token) latch.owner = null; };
  try {
    begin().then(release, release);
  } catch (thrown) {
    // A synchronous throw IS this send's terminal settle.
    release();
    throw thrown;
  }
  return true;
}

/**
 * Abandon the latch: this conversation is a different one now.
 *
 * The abandoned turn's own settle can no longer release it, because the token it
 * holds is no longer the owner. That is the same ordering `admitTurn` relies on,
 * stated once here for the reset path.
 */
export function abandonTurn(latch: SendLatch): void {
  latch.owner = null;
}
