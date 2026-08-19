/**
 * `ctx.storage.transactionSync`, executed. The primitive two production write
 * sets stake their consistency on, and the one place its rollback is real.
 *
 * WHAT WE HAD BEFORE THIS FILE. Nothing that runs the semantic. Core names the
 * requirement — "Run the admit + roster write atomically"
 * (`events/ingress/subordinate.ts:45-46`) — and the CF backend satisfies it at
 * `actor-agent.ts:765`. Every test over that path runs under `bun test`, where
 * core's documented fallback applies: "a backend without one runs the body
 * directly" (`events/ingress/subordinate.ts:7-8`). A bun test therefore passes
 * whether the transaction rolls back, commits partially, or is not there at
 * all — the three outcomes it exists to distinguish.
 *
 * WHY THAT MATTERS ON A LIVE PATH. `applyReport` opens with
 * `requireActive(name)` (`subordinates/support.ts:393-394`) and the event row is
 * already inserted by then, so "the second write throws" is reachable, not
 * hypothetical. Without rollback the parent's rail carries a report its roster
 * never acknowledged; the same primitive under `writeForkSnapshot`
 * (`orchestrator.ts:3280`) decides whether a half-written workspace snapshot is
 * possible.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('DurableObjectStorage.transactionSync', () => {
  // One object per arm: these assertions are about committed rows, so sharing an
  // object would let one arm's writes answer another's count.
  const open = (name: string) => env.TRANSACTION.get(env.TRANSACTION.idFromName(name));

  // Every rejection below is asserted through a THUNK, not by handing the stub's
  // promise to `expect(...)`. A Durable Object RPC promise is a pipelining
  // thenable, and `expect(promise).rejects` consumes it a second time: the extra
  // consumer rejects with nothing awaiting it, which vitest reports as an
  // unhandled rejection and exits the runner non-zero even with every assertion
  // green. Measured on this pool (0.21.3) — the thunk form reports zero errors
  // for the identical assertion.
  it('a throw after the first write leaves neither write behind', async () => {
    const subject = open('atomic-fail');

    await expect(() => subject.admitAtomically('ev-1', true)).rejects.toThrow(/unknown subordinate/);

    // The event row was inserted inside the transaction and is gone. This is the
    // orphan the seam exists to prevent: a report on the parent's rail whose
    // roster row never advanced.
    expect(await subject.admitted()).toEqual({ events: 0, rosterStatus: 'working' });
  });

  // The control that makes the assertion above attributable to the platform and
  // not to a body that never wrote anything. Same class, same body, same throw —
  // only the transaction is removed, and removing it is precisely what core says
  // a non-CF backend does.
  it('the same body without a transaction commits the orphan', async () => {
    const subject = open('direct-fail');

    await expect(() => subject.runDirectly('ev-1', true)).rejects.toThrow(/unknown subordinate/);

    // `bun test` runs this arm. Both numbers below are what every bun test over
    // `receiveSubordinateEvent` actually observes.
    expect(await subject.admitted()).toEqual({ events: 1, rosterStatus: 'working' });
  });

  // The denominator. Without it the `events: 0` above is satisfied by a broken
  // INSERT, a typo in the table name, or a binding that writes nowhere.
  it('the same write set commits when the body returns', async () => {
    const subject = open('atomic-ok');

    await subject.admitAtomically('ev-1', false);

    expect(await subject.admitted()).toEqual({ events: 1, rosterStatus: 'idle' });
  });

  it('an async body commits before it fails, which is why the seam is synchronous', async () => {
    const subject = open('async-body');

    await expect(() => subject.admitViaAsyncBody('ev-1')).rejects.toThrow(/unknown subordinate/);

    // The failure the seam's `transaction<T>(body: () => T): T` type prevents by
    // construction. `transactionSync` committed at the first `await` and the
    // throw arrived after the commit, so the row survives a failed body — the
    // one outcome the first test proves impossible for a synchronous one.
    expect(await subject.admitted()).toEqual({ events: 1, rosterStatus: 'working' });
  });
});
