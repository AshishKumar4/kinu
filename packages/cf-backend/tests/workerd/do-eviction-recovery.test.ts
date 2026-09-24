/**
 * Defends: fiber recovery after an eviction with no client, driven only by the
 * persisted keepAlive alarm (workerd-only: bun has no alarm dispatch or reset).
 * The test waits on a witness object: any request to the probe would run `onStart`'s scan.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** A stub held across a reset is broken by it; the id survives. */
const witness = (name: string) => env.WITNESS.get(env.WITNESS.idFromName(name));

const probe = (name: string) => env.EVICTION_PROBE.get(env.EVICTION_PROBE.idFromName(name));

describe('a durable fiber the activation took with it', () => {
  it('is recovered from the alarm alone, with nothing connected', async () => {
    const stub = probe('fiber-lost');
    await stub.startLostFiber('probe:lost');

    expect(await stub.openFiberRows()).toEqual([
      expect.objectContaining({ name: 'probe:lost' }),
    ]);

    // `keepAlive` does not survive a reset; it only resets the idle timer.
    await abortAllDurableObjects();

    // Nothing addresses the probe from here: only the armed alarm can start recovery.
    expect(await witness('fiber-lost').until('fiber:probe:lost')).toContain('fiber:probe:lost');

    expect(await probe('fiber-lost').openFiberRows()).toEqual([]);
  });
});
