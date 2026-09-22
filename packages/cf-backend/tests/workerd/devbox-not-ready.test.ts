/**
 * A devbox readiness refusal must cross Workers RPC as data: a thrown refusal arrives as a bare `Error`, a returned `RestoreReadiness` keeps its `kind`.
 * Transport only; the adapter half is unit-exec-no-deadline.test.ts (importing the adapter here drags ambient `Env`, see tsconfig.json).
 */
import { env } from 'cloudflare:test';
import { describe, test, expect } from 'vitest';

const stub = () => {
  const ns = env.DEVBOX_NOT_READY_PROBE;

  if (ns === undefined) throw new Error('test runner did not bind DEVBOX_NOT_READY_PROBE (vitest.config.ts)');

  return ns.get(ns.idFromName('probe'));
};

describe('readiness over Workers RPC', () => {
  test('`pending` arrives with its kind and reason intact', async () => {
    const refusal = await stub().resolveReadiness();

    expect(refusal).toEqual({
      kind: 'pending',
      reason: expect.stringContaining('a startup is armed'),
    });
  });

  test('a restored answer arrives intact', async () => {
    expect(await stub().restoredReadiness()).toEqual({ kind: 'restored' });
  });

  test('the thrown form loses its class name — the control', async () => {
    const s = stub();

    expect(await s.localRefusalName()).toBe('StillRestoring');

    // Through a thunk: a second consumer of a Durable Object RPC promise rejects unhandled and vitest exits non-zero
    // with every assertion green. Measured on this pool; see `do-transaction.test.ts`.
    await expect(() => s.namedRefusal()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringContaining('a startup is armed'),
    });
  });
});
