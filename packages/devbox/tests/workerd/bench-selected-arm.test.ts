import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('the selected-arm route guard', () => {
  it('classifies a snapshot-chain state request against a candidates-only fixture', async () => {
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
});
