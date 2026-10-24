/**
 * Defends: a kept delivery's job ending before its own check committed. Alarm invocations overlap (the SDK's deadman,
 * the platform's re-fire of a long one) and run a job again while it runs; a check folded into a running one returned
 * at once, the queue deleted its row, and a reset then lost the push.
 */
import { describe, expect, test } from 'bun:test';
import type { PendingDelivery } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';

// The SDK's lifecycle module imports `cloudflare:workers`: the stand-in must precede it.
mockAgentsSdk();

const { PendingDeliveries } = await import('../src/pending-deliveries');

const TRIGGER = '01HZY6QK9N4T7M2P8V3XABCDEF';

/** The queue's dispatch of the job keeping `key`'s delivery. */
function dispatched(key: string) {
  const pending: PendingDelivery = { trigger: TRIGGER, at: 0, input: null, claim: { key, expiresAt: Number.MAX_SAFE_INTEGER } };

  return {
    job: {
      id: `pending-delivery:${TRIGGER}:${key}`, capability: 'kinu-pending-deliveries', fn: 'pending-delivery', time: 0, payload: pending,
      retry: undefined, singleflight: false, exclusive: false, recoveryLoop: false, createdAt: 0,
    },
    attempt: 1,
  };
}

describe("a trigger's kept deliveries", () => {
  test('are checked one at a time, each job ending only after its own check', async () => {
    const checked: string[] = [];
    const gate = Promise.withResolvers<void>();

    const deliveries = new PendingDeliveries(async (pending) => {
      checked.push(pending.claim.key);

      if (checked.length === 1) await gate.promise;

      return { kind: 'done' };
    });

    const first = deliveries.onJob(dispatched('github:a'));
    // The same job run again by an overlapping alarm, and the trigger's next delivery.
    const again = deliveries.onJob(dispatched('github:a'));
    const next = deliveries.onJob(dispatched('github:b'));

    expect(checked).toEqual(['github:a']);
    expect([Bun.peek.status(again), Bun.peek.status(next)]).toEqual(['pending', 'pending']);

    gate.resolve();
    await Promise.all([first, again, next]);
    expect(checked).toEqual(['github:a', 'github:a', 'github:b']);
  });
});
