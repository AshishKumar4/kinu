import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Enough of a client frame to tell them apart, keeping every other field so a
 *  payload that grew one still fails the equality below. */
const FrameSchema = v.looseObject({ type: v.string() });

/**
 * `sealRpcSurface`, measured against the runtime that enforces it.
 *
 * The seal shadows every unlisted reachable member as an OWN property, which
 * leaves it callable in process and unresolvable only over a stub. So every
 * in-process fixture resolves `broadcast` happily — which is how a producer
 * that called it across a real Durable Object stub shipped green — and
 * `unit-rpc-surface.test.ts` can only state workerd's rule on the suite's own
 * side. This is the one place the rule is measured rather than asserted, and
 * the allowlist is now the whole of what stands between a stub-holder (the
 * owner's UserDO, a peer workspace, the container's object, the preview edge,
 * the CLI transport) and every internal on the root's prototype chain.
 */
describe('the RPC seal over a real root stub', () => {
  it('carries the listed names, lets the callee refuse one, and rejects the inherited ones', async () => {
    const root = env.PLAN_ANNOUNCE_ROOT.get(env.PLAN_ANNOUNCE_ROOT.idFromName('workspace'));
    const { hops, published } = await root.exercise();

    // POSITIVE CONTROL. A listed name and a real hop: the owner's UserDO claims
    // a workspace over exactly this call. Without it every rejection below
    // would hold for a stub that never worked at all.
    expect(hops.claim).toEqual({ ok: true, error: null });

    // Listed, reached, and refused by the CALLEE'S OWN rule — a claim never
    // changes hands mid-activation. The refusal must not be the runtime's
    // "does not implement", because that would mean the name resolved nowhere
    // and the listed half of the allowlist was never exercised.
    expect(hops.second?.ok).toBe(false);
    expect(hops.second?.error ?? '').not.toMatch(/does not implement/);

    // The two inherited members worth stealing. Not Kinu refusals — the runtime
    // never finds the name, which is the whole point: no amount of
    // application-level checking would have produced these, and no in-process
    // double can produce them either.
    expect(hops.broadcast?.ok).toBe(false);
    expect(hops.broadcast?.error ?? '').toMatch(/broadcast/);
    expect(hops.state?.ok).toBe(false);
    expect(hops.state?.error ?? '').toMatch(/setState/);

    // The channel was LIVE while those two were being refused: the object
    // published exactly one frame, in process, through the narrow listed name,
    // carrying exactly what it was given. Deep equality rather than a subset,
    // so a field added to the frame fails here.
    const frames = published.map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    expect(frames.filter((frame) => frame.type === 'head_stream')).toEqual([{
      type: 'head_stream', headId: 'head-wire', kind: 'reasoning', delta: 'kinu-probe-narrow-delta',
    }]);
  });
});
