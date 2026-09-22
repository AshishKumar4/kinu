/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { renderThrownChain } from '@kinu.run/core/obs';

const OWNER_ID = '0123456789abcdef0123456789abcdef';

describe('deleting an account on real workerd', () => {
  it('empties every store, destroys every workspace, and the next sign-in is a new account', async () => {
    // Re-acquired per call: a stub held across `abortAllDurableObjects()` is broken by it.
    const probe = () => env.ACCOUNT_RESET_PROBE.get(env.ACCOUNT_RESET_PROBE.idFromName(OWNER_ID));

    const seeded = await probe().seed();
    expect(seeded.hashes['ws-alpha']).not.toBeNull();
    expect(seeded.hashes['ws-beta']).not.toBeNull();

    const before = await probe().counts();
    expect(before).toMatchObject({
      user_workspaces: 2, user_shares_received: 1, user_mcp_servers: 1, user_credentials: 1, device_consent: 1, user_profile: 1,
    });

    // The SDK's destroy aborts a tick after resolving, so the answer or the `destroyed` sentinel both count.
    let outcome: { kind: 'answered'; answer: { ok: true; workspaces: number } } | { kind: 'rejected'; message: string };

    try {
      outcome = { kind: 'answered', answer: await probe().reset() };
    } catch (cause) {
      outcome = { kind: 'rejected', message: renderThrownChain({ cause }) };
    }

    if (outcome.kind === 'answered') expect(outcome.answer).toEqual({ ok: true, workspaces: 2 });
    else expect(outcome.message).toContain('destroyed');

    // A call in that tick meets the dying object (answering as the empty account) or is cut off
    // and retried on the fresh one; either way every count is zero.
    let inTheTick: Record<string, number>;

    try {
      inTheTick = await probe().counts();
    } catch (cause) {
      if (!renderThrownChain({ cause }).includes('destroyed')) throw cause;
      inTheTick = await probe().counts();
    }

    expect(Object.keys(inTheTick).length).toBeGreaterThan(0);

    for (const [table, count] of Object.entries(inTheTick)) expect({ table, count }).toEqual({ table, count: 0 });

    // The platform's own eviction: the same ids name fresh objects.
    await abortAllDurableObjects();
    const after = await probe().counts();
    expect(Object.keys(after).length).toBeGreaterThan(0);

    for (const [table, count] of Object.entries(after)) expect({ table, count }).toEqual({ table, count: 0 });

    expect(await probe().hashes()).toEqual({ 'ws-alpha': null, 'ws-beta': null });

    const profile = await probe().freshProfile();
    expect(profile?.onboardedAt).toBeNull();
    expect(profile?.displayName).toBeNull();
  });
});
