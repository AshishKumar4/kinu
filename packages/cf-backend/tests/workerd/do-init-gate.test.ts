/**
 * Defends: anything Durable Object init awaits stalls every request on that object, even a pure read.
 * Measured once on a deployed probe: 2303 / 10215 / 25212 ms for a 2s / 10s / 25s busy neighbour,
 * reset at 31s (`platform-catalog.ts:465`); `bun test` has no input gate. 700ms stall, not 25s: same fact, cheaper.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const STALL_MS = 700;

/** `ping()` is `SELECT 1`, so only the gate costs time; half the stall clears scheduling noise. */
const ATTRIBUTABLE_MS = STALL_MS / 2;

describe('Durable Object init gate', () => {
  it('a pure read pays for whatever init awaited', async () => {
    const gated = env.GATED.get(env.GATED.idFromName(`stall:${STALL_MS}`));

    const startedAt = Date.now();
    const answer = await gated.ping();
    const elapsed = Date.now() - startedAt;

    expect(answer).toBe(1);
    expect(elapsed).toBeGreaterThanOrEqual(ATTRIBUTABLE_MS);
  });

  // The control: only the awaited init work differs, so "slow" is not cold start or pool cost.
  it('the shipped shape — init awaits nothing — answers the same read immediately', async () => {
    const clean = env.GATED.get(env.GATED.idFromName('stall:0'));

    const startedAt = Date.now();
    const answer = await clean.ping();
    const elapsed = Date.now() - startedAt;

    expect(answer).toBe(1);
    expect(elapsed).toBeLessThan(ATTRIBUTABLE_MS);
  });

  it('the gate is held per object, so a second request behind it waits too', async () => {
    const gated = env.GATED.get(env.GATED.idFromName(`stall:${STALL_MS}:sibling`));

    const startedAt = Date.now();
    // `fetch`, `webSocketMessage`, `webSocketClose` and `alarm` all await the same gate.
    const answers = await Promise.all([gated.ping(), gated.ping(), gated.ping()]);
    const elapsed = Date.now() - startedAt;

    expect(answers).toEqual([1, 1, 1]);
    expect(elapsed).toBeGreaterThanOrEqual(ATTRIBUTABLE_MS);
  });
});
