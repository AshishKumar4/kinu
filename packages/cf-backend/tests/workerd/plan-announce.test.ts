import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Keeps every other field, so a payload that grew one fails the equality. */
const FrameSchema = v.looseObject({ type: v.string() });

/**
 * `sealRpcSurface` measured against workerd: shadowed members stay callable in process and resolve nowhere
 * over a stub, so only a real Durable Object stub can prove the allowlist.
 */
describe('the RPC seal over a real root stub', () => {
  it('carries the listed names, lets the callee refuse one, and rejects the inherited ones', async () => {
    const root = env.PLAN_ANNOUNCE_ROOT.get(env.PLAN_ANNOUNCE_ROOT.idFromName('workspace'));
    const { hops, published } = await root.exercise();

    // Positive control: a listed name over a real hop.
    expect(hops.claim).toEqual({ ok: true, error: null });

    // Refused by the callee's own rule, not the runtime's "does not implement".
    expect(hops.second?.ok).toBe(false);
    expect(hops.second?.error ?? '').not.toMatch(/does not implement/);

    // The runtime never finds these names; no in-process double can produce this.
    expect(hops.broadcast?.ok).toBe(false);
    expect(hops.broadcast?.error ?? '').toMatch(/broadcast/);
    expect(hops.state?.ok).toBe(false);
    expect(hops.state?.error ?? '').toMatch(/setState/);

    // Deep equality, so a field added to the frame fails here.
    const frames = published.map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    expect(frames.filter((frame) => frame.type === 'head_stream')).toEqual([{
      type: 'head_stream', headId: 'head-wire', kind: 'reasoning', delta: 'kinu-probe-narrow-delta',
    }]);
  });
});
