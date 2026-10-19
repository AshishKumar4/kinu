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
 * The admitted run: `begin`'s own promise, its failure the caller's to read. Null when a turn already holds admission;
 * `begin` is then never called and the caller keeps the draft. `begin` must settle at the turn's terminal settle
 * (finished, failed, or aborted), which releases the latch.
 */
export function admitTurn(latch: SendLatch, begin: () => Promise<void>): Promise<void> | null {
  if (latch.owner !== null) return null;
  const token = ++latch.minted;
  latch.owner = token;
  const release = (): void => { if (latch.owner === token) latch.owner = null; };

  return settleSync(Effect.try({ try: begin, catch: (cause) => ({ cause }) }).pipe(
    Effect.tap((run) => Effect.sync(() => { run.then(release, release); })),
    Effect.tapError(() => Effect.sync(release)),
    Effect.catch((failed) => Effect.die(failed.cause)),
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
