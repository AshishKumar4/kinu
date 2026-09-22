/**
 * Defends: fiber recovery after an eviction with no client, driven only by the
 * persisted keepAlive alarm (workerd-only: bun has no alarm dispatch or reset).
 * The test polls a witness object: any request to the probe would run `onStart`'s scan.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

/** Generous: every wait stops at its condition, so only a failing run pays it. */
const FIBER_DEADLINE_MS = 20_000;

const POLL_MS = 50;

/** A stub held across a reset is broken by it; the id survives. */
const witness = (name: string) => env.WITNESS.get(env.WITNESS.idFromName(name));

const probe = (name: string) => env.EVICTION_PROBE.get(env.EVICTION_PROBE.idFromName(name));

/** Real wall-clock polling: fake timers cannot produce a real alarm delivery. */
async function untilSeen(
  name: string, deadlineMs: number, matches: (notes: string[]) => boolean,
): Promise<string[]> {
  const started = Date.now();

  for (;;) {
    const notes = await witness(name).seen();

    if (matches(notes)) return notes;

    if (Date.now() - started > deadlineMs) return notes;
    await scheduler.wait(POLL_MS);
  }
}

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
    const notes = await untilSeen('fiber-lost', FIBER_DEADLINE_MS, (seen) => seen.includes('fiber:probe:lost'));
    expect(notes).toContain('fiber:probe:lost');

    expect(await probe('fiber-lost').openFiberRows()).toEqual([]);
  });
});
