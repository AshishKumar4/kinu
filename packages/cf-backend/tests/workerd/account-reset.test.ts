/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { renderThrownChain } from '@kinu.run/core/obs';

/** The probe is addressed by the owner's user id — see account-reset-probe.ts. */
const OWNER_ID = '0123456789abcdef0123456789abcdef';

describe('deleting an account on real workerd', () => {
  it('empties every store, destroys every workspace, and the next sign-in is a new account', async () => {
    // Re-acquired per call: a stub held across `abortAllDurableObjects()` is
    // broken by it, and a real caller's next request re-resolves its stub too.
    const probe = () => env.ACCOUNT_RESET_PROBE.get(env.ACCOUNT_RESET_PROBE.idFromName(OWNER_ID));

    const seeded = await probe().seed();
    expect(seeded.hashes['ws-alpha']).not.toBeNull();
    expect(seeded.hashes['ws-beta']).not.toBeNull();

    const before = await probe().counts();
    expect(before).toMatchObject({
      user_workspaces: 2, user_shares_received: 1, user_mcp_servers: 1, user_credentials: 1, device_consent: 1, user_profile: 1,
    });

    // The SDK's destroy aborts the object on the tick after it resolves, so
    // the reply and the abort race: either the answer, or the `destroyed`
    // sentinel the route treats as success, is the platform's honest outcome.
    let outcome: { kind: 'answered'; answer: { ok: true; workspaces: number } } | { kind: 'rejected'; message: string };

    try {
      outcome = { kind: 'answered', answer: await probe().reset() };
    } catch (cause) {
      outcome = { kind: 'rejected', message: renderThrownChain({ cause }) };
    }

    if (outcome.kind === 'answered') expect(outcome.answer).toEqual({ ok: true, workspaces: 2 });
    else expect(outcome.message).toContain('destroyed');

    // The abort that ends the old object is a tick after its reply, and a
    // call landing in that tick meets the dying object itself — measured here:
    // it answers as the empty account (the latch dropped in `deleteAccount`)
    // unless the abort cuts the call off, in which case the next one lands on
    // the fresh object. Either way every count is zero.
    let inTheTick: Record<string, number>;

    try {
      inTheTick = await probe().counts();
    } catch (cause) {
      if (!renderThrownChain({ cause }).includes('destroyed')) throw cause;
      inTheTick = await probe().counts();
    }

    expect(Object.keys(inTheTick).length).toBeGreaterThan(0);

    for (const [table, count] of Object.entries(inTheTick)) expect({ table, count }).toEqual({ table, count: 0 });

    // Then the eviction the platform performs on its own: every object the
    // delete aborted is gone, and the same ids name fresh ones.
    await abortAllDurableObjects();
    const after = await probe().counts();
    expect(Object.keys(after).length).toBeGreaterThan(0);

    for (const [table, count] of Object.entries(after)) expect({ table, count }).toEqual({ table, count: 0 });

    // The workspace objects the delete tore down hold no capability any more.
    expect(await probe().hashes()).toEqual({ 'ws-alpha': null, 'ws-beta': null });

    // And the next sign-in lands on onboarding.
    const profile = await probe().freshProfile();
    expect(profile?.onboardedAt).toBeNull();
    expect(profile?.displayName).toBeNull();
  });
});
