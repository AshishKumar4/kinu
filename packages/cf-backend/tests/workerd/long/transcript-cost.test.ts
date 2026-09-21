/**
 * A turn's cost does not grow with the length of the answers before it.
 *
 * Every step materializes every message in its context. A streamed answer is
 * one `message_updates` row per delta, and until 2026-09-21 each step
 * re-joined every delta row of every past answer: measured under this pool,
 * a 500-delta turn cost 396 ms on an empty transcript and 2,474 ms after
 * twenty 2,000-delta answers (6.2x), and the eval objects spent their 30 s
 * CPU budget on it (D23). With a sealed message projected once at its seal,
 * the same turn measured 364 ms and 375 ms (1.03x).
 *
 * The bound is a RATIO of two timings taken in one process, so machine speed
 * cancels; 3x is far above the fixed shape and far below the regression.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('transcript cost', () => {
  it('a turn after twenty long answers costs what a turn on an empty transcript costs', async () => {
    const root = env.TWO_TURN_PROBE.get(env.TWO_TURN_PROBE.idFromName('transcript-cost'));
    const empty = await root.longTurn(0, 500, 20);
    const loaded = await root.longTurn(20, 500, 2000);

    console.log(`transcript-cost: empty ${empty.longMs} ms, after twenty 2,000-delta answers ${loaded.longMs} ms`);
    expect(loaded.calls).toBeGreaterThanOrEqual(21);
    expect(loaded.longMs).toBeLessThan(empty.longMs * 3);
  });
});
