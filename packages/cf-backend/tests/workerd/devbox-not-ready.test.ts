/**
 * A devbox's readiness refusal reaches its caller as DATA.
 *
 * THE SPLIT THIS FILE PINS. The sandbox object a cf-backend executor commands
 * lives in a DIFFERENT isolate, so `adaptCloudflareSandbox` can only ever read
 * its readiness through Workers RPC serialisation — and a thrown refusal
 * survives that transport as a bare `Error` (the named-class control proves
 * it), while a returned `RestoreReadiness` value arrives with its `kind`
 * intact. That is why the refusal the executor acts on is DATA.
 *
 * DELIBERATELY NOT an adapter test: importing the production adapter would
 * drag its whole `src` closure (ambient `Env`) into THIS project, whose
 * globals are the workerd runner's — packages/cf-backend/tsconfig.json
 * documents the hazard. The adapter half (a `pending` value becomes
 * `KinuError('unavailable')` before dispatch, and the command never exists)
 * is proven bun-side in unit-exec-no-deadline.test.ts against the identical
 * value this file watches cross real RPC, so the production call path is
 * covered end to end with no gap: what the adapter reads post-RPC is
 * observationally identical to the plain object the bun fake hands it.
 *
 * The original test for this seam threw the error across the boundary and
 * asked about the name — which is how `DevboxNotReadyError` came to exist:
 * a class whose name is the whole interface, built to ride a transport that
 * discards exactly that property. Proving it instead made the class
 * unnecessary.
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

    // Through a THUNK, not by handing the stub's promise to `expect(...)`: a
    // Durable Object RPC promise is a pipelining thenable, and a second
    // consumer rejects with nothing awaiting it — vitest exits non-zero on
    // the unhandled rejection with every assertion green. Measured on this
    // pool; see `do-transaction.test.ts`.
    await expect(() => s.namedRefusal()).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringContaining('a startup is armed'),
    });
  });
});
