import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

// ── the incidents route's contract ──────────────────────────────────────────
//
// GET /incidents answers the ledger's reasons, oldest first, for the deployed
// probe to archive after the ladder and after the wake but before teardown.
// What the shapes MEAN is proved in `incident-reasons.test.ts`, which drives
// the real method instead of the HTTP framing around it.
//
// Only guards are asserted here: this environment wires neither the
// container-backed objects nor R2 (a box method answers 502 without them), so
// the positive path runs on the deployed probe, where a failure is loud. The
// /candidate control extension rides the same limit for its container half;
// its method half is proved in `candidate-control-dump.test.ts`.

const auth = { authorization: 'Bearer test-token' };

describe('incidents route', () => {
  it('refuses an unauthenticated incidents request', async () => {
    const response = await SELF.fetch('https://bench.test/incidents?box=probe-1&strategy=bounded-layers');

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
      error: 'strategy is required: snapshot-chain, r2fs, overlay-cas, bounded-layers, or merkle-pack',
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
