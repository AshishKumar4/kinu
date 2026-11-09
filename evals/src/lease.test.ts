// A block of trial accounts is one run's, from its lease to its teardown's end: free only where no run's lock holds it
// and no live armada job's label claims it. Real locks (flock, in a scratch directory) and a fake armada's live jobs.
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaseBlock } from './lease';
import { DEV_IDENTITY_ACCOUNT_HEADER, parseEvalAccount } from '@kinu.run/core';
import { claimLabel, claimOf, onTrialBlock, type SlotClaim } from './slot';

const STAGING = 'staging.kinu.run';

describe('a lease on trial accounts', () => {
  test('a block another run holds is skipped, its own half kept apart, and free again once its lease goes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-leases-'));
    const none = async (): Promise<SlotClaim[]> => [];
    const first = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, dir });
    const second = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, dir });
    const elsewhere = await leaseBlock({ size: 4, pass: false, hosts: ['kinu.run'], liveClaims: none, dir });
    const pass = await leaseBlock({ size: 1, pass: true, hosts: [STAGING], liveClaims: none, dir });

    expect([first.first, second.first, elsewhere.first, pass.first]).toEqual([1, 5, 1, 257]);
    await first.release();
    const again = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: none, dir });

    expect(again.first).toBe(1);
    await Promise.all([second, elsewhere, pass, again].map(async (lease) => lease.release()));
  });

  // Main, 2026-11-09: armada keeps a job about three minutes after the map following it is gone, its trials still acting
  // as the block. A run that died lets its lock go with it; its job's label still claims the block until the job ends.
  test("a dead run's block stays out of reach while its job lives, and nothing of it is deleted until the job has ended", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-leases-'));
    const jobs = new Map<string, string>();
    const live = async (): Promise<SlotClaim[]> => [...jobs.values()].map((label) => claimOf(label)).filter((claim) => claim !== null);
    const deletes: string[] = [];

    // The first run leases trial-1 to trial-4, its job claims them, then the run dies: its lock goes, its job lives on.
    const dead = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, dir });

    jobs.set('j1', claimLabel('5c522f12d44f', { first: dead.first, last: dead.last, hosts: [STAGING] }));
    await dead.release();

    const next = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, dir });

    expect([dead.first, next.first]).toEqual([1, 5]);

    // The second run ends: its teardown deletes its own block, and none of the dead run's, whose job still acts as it.
    const deployment = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        const account = request.headers.get(DEV_IDENTITY_ACCOUNT_HEADER) ?? '';

        if (request.method === 'DELETE' && new URL(request.url).pathname === '/api/user/account') deletes.push(account);

        return new URL(request.url).pathname === '/api/user/credentials' ? Response.json([]) : Response.json({ email: `${account}@kinu.run` });
      },
    });

    try {
      const targets = [5, 6, 7, 8].map((n) => parseEvalAccount(`trial-${String(n)}`)).filter((account) => account !== null)
        .map((account) => ({ origin: deployment.url.origin, identity: { kind: 'secret' as const, secret: 's', account } }));

      await onTrialBlock(next, { targets }, async () => {}, { say: () => {} });
    } finally {
      await deployment.stop(true);
    }

    // Once the dead run's job has ended, its block is free again.
    const meanwhile = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, dir });

    jobs.delete('j1');
    const after = await leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: live, dir });

    expect({ deletes: deletes.sort(), meanwhile: meanwhile.first, after: after.first }).toEqual({ deletes: ['trial-5', 'trial-6', 'trial-7', 'trial-8'], meanwhile: 5, after: 1 });
    await Promise.all([meanwhile.release(), after.release()]);
  });

  test('a run that finds no block free fails at once, naming both holders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'trial-leases-'));
    const all = async (): Promise<SlotClaim[]> => [{ first: 1, last: 256, hosts: [STAGING] }];

    await expect(leaseBlock({ size: 4, pass: false, hosts: [STAGING], liveClaims: all, dir })).rejects.toThrow('their locks');
  });
});
