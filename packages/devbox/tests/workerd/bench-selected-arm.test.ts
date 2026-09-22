import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// An unselected arm is refused before a box prefix is derived from it. `vitest.config.ts`
// sets `BENCH_SELECTED_ARMS` to a non-shipped arm so this refusal is the live path.

describe('the selected-arm route guard', () => {
  it('refuses a state request for an arm this run did not deploy', async () => {
    const response = await SELF.fetch('https://bench.test/state?strategy=snapshot-chain', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      strategy: 'snapshot-chain',
      error: 'strategy not deployed in this run',
    });
  });

  it('refuses an unauthenticated request before it reads an arm at all', async () => {
    const response = await SELF.fetch('https://bench.test/state?strategy=snapshot-chain');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  const UNNAMED_ARMS = [
    { what: 'a request that names no arm at all', url: 'https://bench.test/state' },
    { what: 'an unknown arm name rather than defaulting to the shipped one', url: 'https://bench.test/state?strategy=snapshot-chai' },
  ];

  for (const unnamed of UNNAMED_ARMS) {
    it(`refuses ${unnamed.what}`, async () => {
      const response = await SELF.fetch(unnamed.url, {
        headers: { authorization: 'Bearer test-token' },
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: 'strategy is required: snapshot-chain',
      });
    });
  }
});
