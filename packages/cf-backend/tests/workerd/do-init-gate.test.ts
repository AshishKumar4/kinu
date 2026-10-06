/**
 * Defends: anything Durable Object init awaits stalls every request on that object, even a pure read.
 * Measured 2026-08-16 against a filesystem object busy for 2 / 10 / 25 / 31 s: the read took 2303 / 10215 / 25212 ms,
 * then the object reset; with a clean `onStart`, 216 / 184 / 266 / 339 ms. An idle object answers in 0-2 ms, and one
 * parked inside a turn awaiting the model in 1 ms: the input gate closes around storage, not network awaits.
 * `bun test` has no input gate. 700ms stall, not 25s: same fact, cheaper.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

const STALL_MS = 700;

/** `ping()` is `SELECT 1`, so only the gate costs time; half the stall clears scheduling noise. A lower bound only:
 *  load can only lengthen a gated read, never shorten it. */
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

  // The control: the same stall starts, and only whether init awaits it differs. Asserted as an order, not a
  // duration: a wall-clock bound here measured the machine (618 ms and 1534 ms against 350 under load).
  it('the shipped shape — init awaits nothing — lets the read in before the stall it started settles', async () => {
    const clean = env.GATED.get(env.GATED.idFromName(`stall:${STALL_MS}:detached`));

    expect(await clean.pingAfterInit()).toEqual({ answer: 1, initOutranStall: true });
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
