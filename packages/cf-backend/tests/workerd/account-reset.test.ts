/**
 * @vitest-environment node
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { renderThrownChain } from '@kinu.run/core/obs';

const OWNER_ID = '0123456789abcdef0123456789abcdef';

/** The account's alarm, at most `laps` times, while the account is still there; one the destroy cut off counts as run. */
async function runAlarms(probe: () => { lap: () => Promise<void>; counts: () => Promise<Record<string, number>> }, laps: number): Promise<void> {
  for (let lap = 0; lap < laps; lap += 1) {
    try {
      if ((await probe().counts()).user_profile === 0) return;
      await probe().lap();
    } catch (cause) {
      if (!renderThrownChain({ cause }).includes('destroyed')) throw cause;
    }
  }
}

describe('deleting an account on real workerd', () => {
  it('answers once durable, its jobs empty every store and destroy every workspace, and the next sign-in is a new account', async () => {
    // Re-acquired per call: a stub held across `abortAllDurableObjects()` is broken by it.
    const probe = () => env.ACCOUNT_RESET_PROBE.get(env.ACCOUNT_RESET_PROBE.idFromName(OWNER_ID));

    const seeded = await probe().seed();
    expect(seeded.hashes['ws-alpha']).not.toBeNull();
    expect(seeded.hashes['ws-beta']).not.toBeNull();

    const before = await probe().counts();
    expect(before).toMatchObject({
      user_workspaces: 2, user_share_cards: 2, user_mcp_servers: 1, user_credentials: 1, device_consent: 1, user_profile: 1,
    });

    // Sam deletes their own account: only the share Sam gave is forgotten here.
    await probe().ownerDeleted('f'.repeat(32));
    expect(await probe().receivedFrom()).toEqual(['ana@example.test']);

    // The delete answers once it is durable: each workspace marked, the account marked, every session ended.
    expect(await probe().reset()).toEqual({ ok: true, workspaces: 2 });
    expect({ pending: await probe().pendingDeletes(), profile: (await probe().counts()).user_profile })
      .toEqual({ pending: ['ws-alpha', 'ws-beta'], profile: 1 });

    // Its jobs land it: one workspace an alarm, then the account, whose destroy aborts the object a tick on.
    await runAlarms(probe, 6);

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
