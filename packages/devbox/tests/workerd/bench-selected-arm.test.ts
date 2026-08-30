import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// ── the guards in front of the candidate-facts route ────────────────────────
//
// `GET /candidate` reads one arm's control envelopes and payload closure out of
// the run's shared bucket, so it is the one route whose reply describes another
// arm's prefix if it is reached for the wrong arm. Every guard that stands in
// front of it is asserted here against the real Worker.
//
// The facts it returns are JUDGED by the driver, and that judgement — the
// journal FUSE mount, the control envelope and the payload closure, none of
// which a chain or extraction check can stand in for — is proved in
// `scripts/bench-devbox-decision.test.ts`, where it runs against hand-built
// facts with no deployment. This module cannot import the fixture itself: the
// Worker's module graph reaches `bun:ffi` through the candidate runner it
// bundles for the container, and this project deliberately carries workerd
// types only.

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

  it('holds the candidate-facts route behind that same guard', async () => {
    // A route added after the guard was written is exactly the shape that
    // escapes it. An unselected arm reaching this one would resolve a prefix
    // belonging to a box this run never deployed.
    const response = await SELF.fetch('https://bench.test/candidate?strategy=snapshot-chain', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      strategy: 'snapshot-chain',
      error: 'strategy not deployed in this run',
    });
  });

  it('refuses an unauthenticated candidate-facts request', async () => {
    const response = await SELF.fetch('https://bench.test/candidate?strategy=bounded-layers');

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ ok: false, error: 'unauthorized' });
  });

  it('refuses a candidate-facts request that names no arm at all', async () => {
    const response = await SELF.fetch('https://bench.test/candidate', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: 'strategy is required: snapshot-chain, r2fs, overlay-cas, bounded-layers, or merkle-pack',
    });
  });

  it('refuses an unknown arm name rather than defaulting to one', async () => {
    const response = await SELF.fetch('https://bench.test/candidate?strategy=bounded-layer', {
      headers: { authorization: 'Bearer test-token' },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false });
  });
});
