/**
 * A turn's cost does not grow with the length of the answers before it. Measured 2026-09-21 under this pool: re-joining
 * every delta row of past answers took a 500-delta turn from 396 ms to 2,474 ms (6.2x, D23); projecting sealed messages once, 364/375 ms (1.03x).
 * The bound is a ratio of two timings in one process, so machine speed cancels; 3x sits between fixed shape and regression.
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
