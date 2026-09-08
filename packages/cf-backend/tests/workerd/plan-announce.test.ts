import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

/** Enough of a client frame to tell them apart, keeping every other field so a
 *  payload that grew one still fails the equality below. */
const FrameSchema = v.looseObject({ type: v.string() });

/**
 * The wire the plan-arrival hint crosses.
 *
 * `sealRpcSurface` shadows every unlisted member as an own property, which
 * leaves it callable in process and unresolvable over a stub. Every in-process
 * fixture therefore resolves `broadcast` happily, and the first version of this
 * producer shipped calling it across a real Durable Object stub. These are the
 * assertions that can tell the two apart.
 */
describe('the workspace plan announcement over a real root stub', () => {
  it('refuses the generic broadcast, carries the narrow reference, and still checks the roster', async () => {
    const root = env.PLAN_ANNOUNCE_ROOT.get(env.PLAN_ANNOUNCE_ROOT.idFromName('workspace'));
    const { hops, published } = await root.exercise();

    // The shipped call. Not a Kinu refusal — the runtime never finds the name,
    // which is the whole point: no amount of application-level checking would
    // have produced this, and no in-process double can produce it either.
    expect(hops.broadcast?.ok).toBe(false);
    expect(hops.broadcast?.error ?? '').toMatch(/broadcast/);

    // The narrow name the root's allowlist carries.
    expect(hops.announce).toEqual({ ok: true, error: null });

    // Reachable is not the same as trusted: the endpoint answers from the
    // workspace's own roster, so a path it never hired is refused on arrival.
    expect(hops.unrostered?.ok).toBe(false);
    expect(hops.unrostered?.error ?? '').toContain('no such plan actor');
    // Exactly one plan frame reached the workspace's clients, carrying the
    // closed reference and nothing else — no plan body, no owner, no author.
    // Filtered by type because a real activation also sends the SDK's own
    // `cf_agent_mcp_servers` frame, which is the point of using a real root.
    const frames = published.map((frame) => v.parse(FrameSchema, JSON.parse(frame)));
    expect(frames.filter((frame) => frame.type === 'workspace_plan_updated')).toEqual([{
      type: 'workspace_plan_updated',
      reference: { path: ['child'], id: 'plan-wire', revision: 1 },
    }]);
    // And the refused hops published nothing at all under any other name.
    expect(published.filter((frame) => frame.includes('plan-wire'))).toHaveLength(1);
  });
});
