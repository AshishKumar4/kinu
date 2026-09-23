/**
 * `ctx.storage.transactionSync`, executed. Defends: the admit + roster write (`actor-agent.ts`) and
 * a fork's publication committing partially; under bun the body runs directly, so only workerd can tell.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

describe('DurableObjectStorage.transactionSync', () => {
  // One object per arm, so one arm's writes cannot answer another's count.
  const open = (name: string) => env.TRANSACTION.get(env.TRANSACTION.idFromName(name));

  // Rejections go through a thunk: `expect(rpcPromise).rejects` consumes the pipelining thenable twice and
  // vitest exits non-zero on the unhandled rejection. Measured on this pool (0.21.3).
  it('a throw after the first write leaves neither write behind', async () => {
    const subject = open('atomic-fail');

    await expect(() => subject.admitAtomically('ev-1', true)).rejects.toThrow(/unknown subordinate/);

    expect(await subject.admitted()).toEqual({ events: 0, rosterStatus: 'working' });
  });

  // Control: same body without the transaction, which is what core says a non-CF backend does.
  it('the same body without a transaction commits the orphan', async () => {
    const subject = open('direct-fail');

    await expect(() => subject.runDirectly('ev-1', true)).rejects.toThrow(/unknown subordinate/);

    expect(await subject.admitted()).toEqual({ events: 1, rosterStatus: 'working' });
  });

  // The denominator: without it `events: 0` is satisfied by a broken INSERT.
  it('the same write set commits when the body returns', async () => {
    const subject = open('atomic-ok');

    await subject.admitAtomically('ev-1', false);

    expect(await subject.admitted()).toEqual({ events: 1, rosterStatus: 'idle' });
  });

  it('an async body commits before it fails, which is why the seam is synchronous', async () => {
    const subject = open('async-body');

    await expect(() => subject.admitViaAsyncBody('ev-1')).rejects.toThrow(/unknown subordinate/);

    // `transactionSync` commits at the first `await`, so an async body's row survives its throw.
    expect(await subject.admitted()).toEqual({ events: 1, rosterStatus: 'working' });
  });
});
