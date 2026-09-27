/**
 * Synchronous chat-send latch, acquired before any async step and released by the matching send's terminal
 * settle. React state cannot own it: two presses in one tick both read the uncommitted value.
 */
import { Effect } from 'effect';
import { settleSync } from '../obs/effect';

/** Tokens strictly increase, so a stale settle cannot release the latch held by a later send. */
export interface SendLatch {
  minted: number;
  owner: number | null;
}

export function newSendLatch(): SendLatch {
  return { minted: 0, owner: null };
}

/**
 * `false` when a turn already holds admission; `begin` is then never called and the caller keeps the draft.
 * `begin` must resolve at the turn's terminal settle (finished, failed, or aborted).
 */
export function admitTurn(latch: SendLatch, begin: () => Promise<void>): boolean {
  if (latch.owner !== null) return false;
  const token = ++latch.minted;
  latch.owner = token;
  const release = (): void => { if (latch.owner === token) latch.owner = null; };

  return settleSync(Effect.try({ try: () => { begin().then(release, release); }, catch: (cause) => ({ cause }) }).pipe(
    Effect.tapError(() => Effect.sync(release)),
    Effect.catch((failed) => Effect.die(failed.cause)),
    Effect.as(true),
  ));
}

/** The abandoned turn's settle can no longer release it: its token is no longer the owner. */
export function abandonTurn(latch: SendLatch): void {
  latch.owner = null;
}

/** The abort path awaits two RPCs before releasing; a send admitted in that window must keep the latch. */
export function abandonTurnIfOwner(latch: SendLatch, expected: number | null): void {
  if (expected === null) return;

  if (latch.owner === expected) latch.owner = null;
}
