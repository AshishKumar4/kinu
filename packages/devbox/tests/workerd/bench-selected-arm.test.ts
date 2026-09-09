import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// ── the guard in front of every instrumented route ──────────────────────────
//
// Every route execs commands inside a container and resolves a box prefix from
// the arm it is asked for, so an arm this run did not deploy must be refused
// BEFORE a prefix is derived — otherwise the reply describes a box the run never
// created. `BENCH_SELECTED_ARMS` in `vitest.config.ts` deliberately names an arm
// that is not the shipped one, so the refusal below is the live path rather than
// a branch nothing reaches.
//
// The instrument's own judgement of what a run measured is proved in
// `scripts/bench-devbox-decision.test.ts`, against hand-built facts with no
// deployment.

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

  it('refuses a request that names no arm at all', async () => {
    const response = await SELF.fetch('https://bench.test/state', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'strategy is required: snapshot-chain',
    });
  });

  it('refuses an unknown arm name rather than defaulting to the shipped one', async () => {
    const response = await SELF.fetch('https://bench.test/state?strategy=snapshot-chai', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'strategy is required: snapshot-chain',
    });
  });
});
