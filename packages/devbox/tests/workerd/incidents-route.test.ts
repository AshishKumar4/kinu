import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// Only guards are asserted: this environment wires neither container-backed objects nor R2,
// so the positive path runs on the deployed probe; `incident-reasons.test.ts` covers shapes.

const auth = { authorization: 'Bearer test-token' };

describe('incidents route', () => {
  it('refuses an unauthenticated incidents request', async () => {
    const response = await SELF.fetch('https://bench.test/incidents?box=probe-1&strategy=snapshot-chain');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('refuses an incidents request that names no arm at all', async () => {
    const response = await SELF.fetch('https://bench.test/incidents?box=probe-1', {
      headers: auth,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'strategy is required: snapshot-chain',
    });
  });

  it('holds incidents behind the same deployment guard', async () => {
    const response = await SELF.fetch('https://bench.test/incidents?box=probe-1&strategy=snapshot-chain', {
      headers: auth,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      strategy: 'snapshot-chain',
      error: 'strategy not deployed in this run',
    });
  });
});
